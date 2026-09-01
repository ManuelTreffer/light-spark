import { crc32 } from '../../core/crc32';
import type { TilePayload } from './tiles';

/**
 * Reassembles one Protocol v2 frame's bytes from Spark Grid tile fragments
 * (Milestone 5.2, Milestone 8.3's 7-step pipeline). What actually gets
 * fragmented across tiles is `[frameCrc32:4][the real frame bytes]` — a
 * *second*, independent integrity check on top of each tile's own CRC
 * (`tiles.ts`'s `decodeTilePayload`), catching e.g. two generations' tiles
 * getting mixed up rather than any single tile being corrupted (each tile
 * already can't be, by the time `ingestTile` is called — see
 * `channels/grid/receiver.ts`'s eventual wiring, not part of this PR). This
 * mirrors the same "never hand a decoder unverified data" discipline as
 * every other decode boundary in this codebase (`core/packet.ts`,
 * `protocol/frameHeader.ts`, `protocol/manifest.ts`).
 *
 * `ingestTile` only ever returns fully-reassembled, frame-CRC-verified
 * bytes, or `null` — a caller downstream (a v2 `decodeCommonFrameHeader`,
 * ultimately) never sees a partially- or un-verified reassembly.
 */

const DEFAULT_MAX_GENERATIONS_IN_FLIGHT = 2;
/** A generous but concrete ceiling on one fragmented frame's total size —
 * "Fragmentpuffer haben feste Grenzen". Every Protocol v2 frame emitted so
 * far (a Manifest, a Data frame's chunk) is well under this even at the
 * largest Grid preset's per-frame capacity; this exists to bound a
 * malformed or adversarial `tileCount`/`fragmentLength` claim, not because
 * any real frame needs to get this big. */
const DEFAULT_MAX_FRAME_BYTES = 8192;

const FRAME_CRC_SIZE = 4;

interface Generation {
  readonly tileCount: number;
  readonly fragments: (Uint8Array | undefined)[];
  /** Expected `fragmentOffset` for the next not-yet-received tile, in
   * tileIndex order — cross-checked against what each tile actually claims,
   * catching an inconsistent/corrupted offset even though tileIndex (not
   * fragmentOffset) is what actually orders the reassembly. */
  expectedOffsets: number[];
  receivedCount: number;
  totalBytes: number;
  lastTouchedAt: number;
}

export interface FrameFragmentAssemblerOptions {
  /** How many distinct `tileSequence` generations may be tracked at once —
   * beyond this, the least-recently-touched incomplete one is discarded to
   * make room ("unvollständige Frames nach einem Limit verwerfen"). */
  readonly maxGenerationsInFlight?: number;
  readonly maxFrameBytes?: number;
}

export class FrameFragmentAssembler {
  private readonly maxGenerationsInFlight: number;
  private readonly maxFrameBytes: number;
  /** Keyed by tileSequence. Bounded by `maxGenerationsInFlight` — this is
   * exactly the kind of "no unbounded set of everything ever seen" case
   * Milestone 2.4 already established the pattern for; the fix here is the
   * same shape, just at the tile-reassembly layer instead of the
   * Fountain-decoder layer. */
  private readonly generations = new Map<number, Generation>();

  constructor(options: FrameFragmentAssemblerOptions = {}) {
    this.maxGenerationsInFlight = options.maxGenerationsInFlight ?? DEFAULT_MAX_GENERATIONS_IN_FLIGHT;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  }

  /** Feeds one already tile-CRC-verified `TilePayload` (see
   * `tiles.ts`'s `decodeTilePayload`/`decodeTileFromCells` — this class
   * never re-checks a tile's own CRC, only the reassembled frame's).
   * Returns the frame-CRC-verified frame bytes once every tile for this
   * generation has arrived, `null` otherwise — including when the
   * generation is now complete but the frame CRC didn't match (that
   * generation is discarded either way, never retried from stale data). */
  ingestTile(tile: TilePayload): Uint8Array | null {
    if (tile.tileCount === 0 || tile.tileIndex >= tile.tileCount) return null;

    let generation = this.generations.get(tile.tileSequence);
    if (generation && generation.tileCount !== tile.tileCount) {
      // A different tileCount claim for an already-tracked generation is a
      // contradiction, not new information — start over rather than guess
      // which claim to believe.
      this.generations.delete(tile.tileSequence);
      generation = undefined;
    }

    if (!generation) {
      this.evictIfAtCapacity();
      generation = {
        tileCount: tile.tileCount,
        fragments: new Array(tile.tileCount),
        expectedOffsets: new Array(tile.tileCount).fill(-1),
        receivedCount: 0,
        totalBytes: 0,
        lastTouchedAt: Date.now(),
      };
      this.generations.set(tile.tileSequence, generation);
    }

    generation.lastTouchedAt = Date.now();

    if (generation.fragments[tile.tileIndex]) return null; // duplicate tile — ignored, not an error

    if (generation.totalBytes + tile.fragment.length > this.maxFrameBytes) {
      // A generation whose claimed total would exceed the bound is dropped
      // outright, not partially accepted.
      this.generations.delete(tile.tileSequence);
      return null;
    }

    generation.fragments[tile.tileIndex] = tile.fragment;
    generation.expectedOffsets[tile.tileIndex] = tile.fragmentOffset;
    generation.receivedCount++;
    generation.totalBytes += tile.fragment.length;

    if (generation.receivedCount < generation.tileCount) return null;

    this.generations.delete(tile.tileSequence);
    return this.reassemble(generation);
  }

  private reassemble(generation: Generation): Uint8Array | null {
    // Concatenate in tileIndex order — the actual, authoritative ordering —
    // while cross-checking each tile's self-reported fragmentOffset against
    // where it would land under that ordering. A mismatch means something
    // is internally inconsistent (a bug, or a tile from an unrelated
    // encoding scheme that happened to pass its own CRC) and the whole
    // reassembly is abandoned rather than trusted partially.
    const combined = new Uint8Array(generation.totalBytes);
    let offset = 0;
    for (const fragment of generation.fragments) {
      combined.set(fragment!, offset);
      offset += fragment!.length;
    }

    let expected = 0;
    for (let i = 0; i < generation.fragments.length; i++) {
      if (generation.expectedOffsets[i] !== expected) return null;
      expected += generation.fragments[i]!.length;
    }

    if (combined.length < FRAME_CRC_SIZE) return null;
    const view = new DataView(combined.buffer, combined.byteOffset, combined.byteLength);
    const expectedCrc = view.getUint32(0, false);
    const frameBytes = combined.subarray(FRAME_CRC_SIZE);
    return crc32(frameBytes) === expectedCrc ? frameBytes : null;
  }

  private evictIfAtCapacity(): void {
    if (this.generations.size < this.maxGenerationsInFlight) return;
    let oldestKey: number | null = null;
    let oldestTime = Infinity;
    for (const [key, generation] of this.generations) {
      if (generation.lastTouchedAt < oldestTime) {
        oldestTime = generation.lastTouchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.generations.delete(oldestKey);
  }
}

/** Prepends the frame-level CRC-32 that `FrameFragmentAssembler` expects to
 * find once reassembly completes — the sender-side counterpart, used before
 * splitting `frameBytes` across tiles. */
export function wrapFrameForFragmentation(frameBytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_CRC_SIZE + frameBytes.length);
  new DataView(out.buffer).setUint32(0, crc32(frameBytes), false);
  out.set(frameBytes, FRAME_CRC_SIZE);
  return out;
}
