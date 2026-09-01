import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../../core/rng';
import { FrameFragmentAssembler, wrapFrameForFragmentation } from './fragmentAssembler';
import type { TilePayload } from './tiles';

function randomBytes(n: number, seed: number): Uint8Array {
  const rand = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

/** Splits `wrapFrameForFragmentation(frameBytes)` into `tileCount` roughly
 * equal fragments, as tile-sized TilePayloads (fragment CRCs are not part of
 * this class's concern — those are tiles.ts's job — so this helper just
 * builds the logical TilePayload objects directly). */
function fragment(frameBytes: Uint8Array, tileSequence: number, tileCount: number): TilePayload[] {
  const wrapped = wrapFrameForFragmentation(frameBytes);
  const perTile = Math.ceil(wrapped.length / tileCount);
  const tiles: TilePayload[] = [];
  let offset = 0;
  for (let i = 0; i < tileCount; i++) {
    const length = Math.min(perTile, wrapped.length - offset);
    tiles.push({
      tileIndex: i,
      tileSequence,
      tileCount,
      fragmentOffset: offset,
      fragmentLength: length,
      fragment: wrapped.subarray(offset, offset + length),
    });
    offset += length;
  }
  return tiles;
}

describe('FrameFragmentAssembler — reassembly', () => {
  it('reassembles a frame once every tile has arrived, in order', () => {
    const frameBytes = randomBytes(300, 1);
    const tiles = fragment(frameBytes, 1, 6);
    const assembler = new FrameFragmentAssembler();

    let result: Uint8Array | null = null;
    for (const tile of tiles) {
      const r = assembler.ingestTile(tile);
      if (r) result = r;
    }
    expect(result).toEqual(frameBytes);
  });

  it('reassembles correctly when tiles arrive out of order', () => {
    const frameBytes = randomBytes(500, 2);
    const tiles = fragment(frameBytes, 1, 8);
    const shuffled = [...tiles].reverse();
    const assembler = new FrameFragmentAssembler();

    let result: Uint8Array | null = null;
    for (const tile of shuffled) {
      const r = assembler.ingestTile(tile);
      if (r) result = r;
    }
    expect(result).toEqual(frameBytes);
  });

  it('duplicate tiles are ignored, not double-counted', () => {
    const frameBytes = randomBytes(200, 3);
    const tiles = fragment(frameBytes, 1, 4);
    const assembler = new FrameFragmentAssembler();

    expect(assembler.ingestTile(tiles[0])).toBeNull();
    expect(assembler.ingestTile(tiles[0])).toBeNull(); // duplicate
    expect(assembler.ingestTile(tiles[0])).toBeNull(); // duplicate again
    expect(assembler.ingestTile(tiles[1])).toBeNull();
    expect(assembler.ingestTile(tiles[2])).toBeNull();
    expect(assembler.ingestTile(tiles[3])).toEqual(frameBytes); // completes despite the duplicates
  });

  it('a single tile occlusion does not corrupt the other tiles — the frame just waits', () => {
    const frameBytes = randomBytes(400, 4);
    const tiles = fragment(frameBytes, 1, 5);
    const assembler = new FrameFragmentAssembler();

    // Tile 2 is "occluded" (never delivered) on this pass.
    for (const tile of tiles) {
      if (tile.tileIndex === 2) continue;
      expect(assembler.ingestTile(tile)).toBeNull();
    }
    // The missing tile arrives on a retry with the SAME generation number
    // (as a real repeating sender would eventually resend it).
    expect(assembler.ingestTile(tiles[2])).toEqual(frameBytes);
  });

  it('multiple independent generations do not interfere with each other', () => {
    const frameA = randomBytes(150, 10);
    const frameB = randomBytes(150, 11);
    const tilesA = fragment(frameA, 1, 3);
    const tilesB = fragment(frameB, 2, 3);
    const assembler = new FrameFragmentAssembler({ maxGenerationsInFlight: 2 });

    // Interleave A and B's tiles.
    expect(assembler.ingestTile(tilesA[0])).toBeNull();
    expect(assembler.ingestTile(tilesB[0])).toBeNull();
    expect(assembler.ingestTile(tilesA[1])).toBeNull();
    expect(assembler.ingestTile(tilesB[1])).toBeNull();
    expect(assembler.ingestTile(tilesA[2])).toEqual(frameA);
    expect(assembler.ingestTile(tilesB[2])).toEqual(frameB);
  });
});

describe('FrameFragmentAssembler — bounds', () => {
  it('evicts the oldest incomplete generation once at capacity', () => {
    const assembler = new FrameFragmentAssembler({ maxGenerationsInFlight: 1 });
    const frameA = randomBytes(100, 20);
    const frameB = randomBytes(100, 21);
    const tilesA = fragment(frameA, 1, 3);
    const tilesB = fragment(frameB, 2, 3);

    // Start generation 1 (incomplete: 2 of 3 tiles).
    assembler.ingestTile(tilesA[0]);
    assembler.ingestTile(tilesA[1]);

    // A new generation with only 1 slot available evicts generation 1 entirely.
    assembler.ingestTile(tilesB[0]);
    assembler.ingestTile(tilesB[1]);
    expect(assembler.ingestTile(tilesB[2])).toEqual(frameB);

    // Generation 1's remaining tile can no longer complete it — it starts a
    // brand new (now-incomplete) generation instead of resurrecting the old one.
    expect(assembler.ingestTile(tilesA[2])).toBeNull();
  });

  it('rejects a generation whose claimed total exceeds maxFrameBytes', () => {
    const assembler = new FrameFragmentAssembler({ maxFrameBytes: 50 });
    const bigFrame = randomBytes(200, 30);
    const tiles = fragment(bigFrame, 1, 4); // each fragment ~50 bytes, four of them exceeds the 50-byte cap
    let anyCompleted = false;
    for (const tile of tiles) {
      const result = assembler.ingestTile(tile);
      if (result) anyCompleted = true;
    }
    expect(anyCompleted).toBe(false);
  });

  it('a tileCount that disagrees with an already-tracked generation restarts it rather than corrupting it', () => {
    const assembler = new FrameFragmentAssembler();
    const frameBytes = randomBytes(120, 40);
    const tiles = fragment(frameBytes, 1, 3);

    assembler.ingestTile(tiles[0]);
    // A tile claiming a different tileCount for the same tileSequence — either
    // corruption or a stale/colliding sequence number.
    const inconsistent: TilePayload = { ...tiles[1], tileCount: 5 };
    expect(assembler.ingestTile(inconsistent)).toBeNull();

    // The original generation was discarded, not silently merged — finishing
    // it now needs all of its tiles resent from scratch.
    expect(assembler.ingestTile(tiles[0])).toBeNull();
    expect(assembler.ingestTile(tiles[1])).toBeNull();
    expect(assembler.ingestTile(tiles[2])).toEqual(frameBytes);
  });
});

describe('FrameFragmentAssembler — frame-level integrity', () => {
  it('rejects a reassembly whose frame CRC does not match (tiles individually fine, whole doesn\'t add up)', () => {
    const frameBytes = randomBytes(100, 50);
    const tiles = fragment(frameBytes, 1, 4);
    // Corrupt one fragment's bytes directly (simulating e.g. a tile whose own
    // CRC happened to still pass despite carrying wrong bytes — astronomically
    // unlikely in practice, but this test isolates the frame-CRC layer from
    // the tile-CRC layer on purpose, per Milestone 8.3's two-stage design).
    const corrupted = tiles.map((t) => (t.tileIndex === 2 ? { ...t, fragment: t.fragment.map((b) => b ^ 0xff) } : t));

    const assembler = new FrameFragmentAssembler();
    let result: Uint8Array | null = null;
    for (const tile of corrupted) {
      const r = assembler.ingestTile(tile);
      if (r) result = r;
    }
    expect(result).toBeNull();
  });

  it('rejects reassembly when fragment offsets are internally inconsistent', () => {
    const frameBytes = randomBytes(80, 60);
    const tiles = fragment(frameBytes, 1, 4);
    const withBadOffset = tiles.map((t) => (t.tileIndex === 1 ? { ...t, fragmentOffset: t.fragmentOffset + 5 } : t));

    const assembler = new FrameFragmentAssembler();
    let result: Uint8Array | null = null;
    for (const tile of withBadOffset) {
      const r = assembler.ingestTile(tile);
      if (r) result = r;
    }
    expect(result).toBeNull();
  });
});

describe('wrapFrameForFragmentation', () => {
  it('prepends a CRC-32 that fragment reassembly can verify', () => {
    const frameBytes = randomBytes(64, 70);
    const wrapped = wrapFrameForFragmentation(frameBytes);
    expect(wrapped.length).toBe(frameBytes.length + 4);
  });
});
