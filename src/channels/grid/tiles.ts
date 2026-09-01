import { crc32 } from '../../core/crc32';
import { readBits, writeBits } from './codec';
import { geometryFor, type GridSpec } from './spec';

/**
 * Spark Grid tiling (Milestone 5). A frame's data area — the same
 * `dataRows.length × spec.cells` rectangle `codec.ts`'s monolithic
 * `encodeGridCells`/`decodeGridCells` already treat as one bitstream — is
 * instead partitioned into independent rectangular tiles, each with its own
 * small header and CRC-32. A camera glare or partial occlusion that used to
 * corrupt the *entire* frame (one CRC over everything) now only costs the
 * tile(s) actually affected — see `docs/adr/0006-spark-grid-tiling.md` for
 * the full reasoning, including why this is fragmentation (one Protocol v2
 * frame's bytes spread across several tiles) rather than "one independent
 * Fountain droplet per tile".
 *
 * `renderGrid`/`detectGrid` (`render.ts`/`detect.ts`) are completely
 * unchanged and unaware of tiling — they only ever see a flat
 * `cells: Uint8Array` of one colour index per data cell. Tiling is purely a
 * different way of *interpreting* that same flat array, entirely within
 * this file and `codec.ts`'s exported bit-packing helpers.
 */

export interface TileCellRect {
  /** Offset into the row-major data-cell array, in tile-local row/col units — see `tileRect`. */
  readonly rowStart: number;
  readonly rowCount: number;
  readonly colStart: number;
  readonly colCount: number;
}

export interface TileGridLayout {
  readonly tileRows: number;
  readonly tileCols: number;
  readonly tileCount: number;
  tileRect(tileIndex: number): TileCellRect;
  /** Bytes available for `[header][fragment][crc]` within this tile's cell rectangle. */
  tileCapacityBytes(tileIndex: number): number;
}

/** Splits `total` units into `groups` non-empty, near-equal integer counts —
 * the extras (if `total` doesn't divide evenly) go to the first groups, the
 * same "shorter last piece" asymmetry `transfer/blockPlan.ts` uses, just
 * mirrored (there the *last* group is shorter; here it doesn't matter which
 * end absorbs the remainder, so the simplest implementation is used). */
function evenSplit(total: number, groups: number): number[] {
  if (groups <= 0) throw new Error(`groups must be positive, got ${groups}`);
  if (groups > total) throw new Error(`cannot split ${total} into ${groups} non-empty groups`);
  const base = Math.floor(total / groups);
  const remainder = total % groups;
  return Array.from({ length: groups }, (_, i) => base + (i < remainder ? 1 : 0));
}

function prefixSums(counts: readonly number[]): number[] {
  const starts: number[] = [];
  let sum = 0;
  for (const c of counts) {
    starts.push(sum);
    sum += c;
  }
  return starts;
}

/** `tileRows`/`tileCols` are a caller-chosen density, not fixed by the
 * preset — see the ADR for why capacity varies enormously by preset (a
 * 3×3 tiling is workable on Grid-turbo, cramped on Grid-safe) and why this
 * PR leaves that choice to whoever eventually wires tiling into a real
 * sender rather than hard-coding one number now. */
export function tileLayoutFor(spec: GridSpec, tileRows: number, tileCols: number): TileGridLayout {
  const geometry = geometryFor(spec);
  const rowCounts = evenSplit(geometry.dataRows.length, tileRows);
  const colCounts = evenSplit(spec.cells, tileCols);
  const rowStarts = prefixSums(rowCounts);
  const colStarts = prefixSums(colCounts);
  const tileCount = tileRows * tileCols;

  return {
    tileRows,
    tileCols,
    tileCount,
    tileRect(tileIndex: number): TileCellRect {
      if (tileIndex < 0 || tileIndex >= tileCount) throw new Error(`tileIndex ${tileIndex} out of range [0, ${tileCount})`);
      const tr = Math.floor(tileIndex / tileCols);
      const tc = tileIndex % tileCols;
      return { rowStart: rowStarts[tr], rowCount: rowCounts[tr], colStart: colStarts[tc], colCount: colCounts[tc] };
    },
    tileCapacityBytes(tileIndex: number): number {
      const rect = this.tileRect(tileIndex);
      return Math.floor((rect.rowCount * rect.colCount * spec.palette.bitsPerCell) / 8);
    },
  };
}

/** tileIndex(1) + tileSequence(1) + tileCount(1) + fragmentOffset(2) + fragmentLength(2). */
export const TILE_HEADER_SIZE = 7;
export const TILE_CRC_SIZE = 4;

export interface TilePayload {
  readonly tileIndex: number;
  readonly tileSequence: number;
  /** How many tiles make up the generation this tile belongs to — may be
   * fewer than the layout's full `tileCount` if the fragmented content is
   * short enough to need only some of the available tiles. Redundant
   * across every tile of one generation (the same way `DataFrameHeader`'s
   * `blockSourceChunkCount` is redundant across a block's drops), which is
   * exactly what lets `FrameFragmentAssembler` know, unambiguously and
   * without a separate "total length" field, when a generation is complete. */
  readonly tileCount: number;
  readonly fragmentOffset: number;
  readonly fragmentLength: number;
  readonly fragment: Uint8Array;
}

/** Encodes one tile's payload bytes (header + fragment + CRC-32 over both).
 * Does **not** place it into cells — see `writeTileIntoCells`. */
export function encodeTilePayload(tile: TilePayload): Uint8Array {
  if (tile.fragment.length !== tile.fragmentLength) throw new Error('fragment.length must equal fragmentLength');
  if (tile.tileIndex > 0xff || tile.tileSequence > 0xff || tile.tileCount > 0xff) {
    throw new Error('tileIndex/tileSequence/tileCount must fit in a byte');
  }
  if (tile.tileIndex >= tile.tileCount) throw new Error(`tileIndex ${tile.tileIndex} must be < tileCount ${tile.tileCount}`);
  if (tile.fragmentOffset > 0xffff || tile.fragmentLength > 0xffff) {
    throw new Error('fragmentOffset/fragmentLength must fit in a uint16');
  }

  const out = new Uint8Array(TILE_HEADER_SIZE + tile.fragment.length + TILE_CRC_SIZE);
  const view = new DataView(out.buffer);
  out[0] = tile.tileIndex;
  out[1] = tile.tileSequence;
  out[2] = tile.tileCount;
  view.setUint16(3, tile.fragmentOffset, false);
  view.setUint16(5, tile.fragmentLength, false);
  out.set(tile.fragment, TILE_HEADER_SIZE);
  view.setUint32(TILE_HEADER_SIZE + tile.fragment.length, crc32(out.subarray(0, TILE_HEADER_SIZE + tile.fragment.length)), false);
  return out;
}

/** Returns `null` for anything that isn't a plausible, CRC-intact tile —
 * misreads off a camera are routine here, same convention as every other
 * decode boundary in this codebase. Tolerates trailing zero padding (a
 * tile's on-screen capacity is usually larger than one specific fragment). */
export function decodeTilePayload(bytes: Uint8Array): TilePayload | null {
  if (bytes.length < TILE_HEADER_SIZE + TILE_CRC_SIZE) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tileIndex = bytes[0];
  const tileSequence = bytes[1];
  const tileCount = bytes[2];
  const fragmentOffset = view.getUint16(3, false);
  const fragmentLength = view.getUint16(5, false);

  if (tileCount === 0 || tileIndex >= tileCount) return null;
  if (TILE_HEADER_SIZE + fragmentLength + TILE_CRC_SIZE > bytes.length) return null;

  const expectedCrc = view.getUint32(TILE_HEADER_SIZE + fragmentLength, false);
  const actualCrc = crc32(bytes.subarray(0, TILE_HEADER_SIZE + fragmentLength));
  if (actualCrc !== expectedCrc) return null;

  return {
    tileIndex,
    tileSequence,
    tileCount,
    fragmentOffset,
    fragmentLength,
    fragment: bytes.slice(TILE_HEADER_SIZE, TILE_HEADER_SIZE + fragmentLength),
  };
}

/** Writes one tile's encoded payload bytes into its rectangle of `fullCells`
 * (the same flat, row-major data-cell array `renderGrid` consumes). Pads
 * with zero bytes up to the tile's full capacity — the padding is never
 * interpreted as anything (see `decodeTilePayload`'s length-bounded CRC). */
export function writeTileIntoCells(fullCells: Uint8Array, spec: GridSpec, layout: TileGridLayout, tileIndex: number, payload: Uint8Array): void {
  const rect = layout.tileRect(tileIndex);
  const capacity = layout.tileCapacityBytes(tileIndex);
  if (payload.length > capacity) {
    throw new Error(`tile payload (${payload.length} bytes) exceeds this tile's capacity (${capacity} bytes)`);
  }

  const padded = new Uint8Array(capacity);
  padded.set(payload);

  const bits = spec.palette.bitsPerCell;
  let k = 0;
  for (let r = 0; r < rect.rowCount; r++) {
    const rowBase = (rect.rowStart + r) * spec.cells;
    for (let c = 0; c < rect.colCount; c++) {
      fullCells[rowBase + rect.colStart + c] = readBits(padded, k * bits, bits);
      k++;
    }
  }
}

/** Inverse of `writeTileIntoCells` — extracts and unpacks one tile's raw
 * capacity-sized byte buffer from `fullCells`. Pass the result straight to
 * `decodeTilePayload`. */
export function readTileFromCells(fullCells: Uint8Array, spec: GridSpec, layout: TileGridLayout, tileIndex: number): Uint8Array {
  const rect = layout.tileRect(tileIndex);
  const capacity = layout.tileCapacityBytes(tileIndex);
  const bits = spec.palette.bitsPerCell;

  const bytes = new Uint8Array(capacity);
  let k = 0;
  for (let r = 0; r < rect.rowCount; r++) {
    const rowBase = (rect.rowStart + r) * spec.cells;
    for (let c = 0; c < rect.colCount; c++) {
      writeBits(bytes, k * bits, bits, fullCells[rowBase + rect.colStart + c]);
      k++;
    }
  }
  return bytes;
}

/** Convenience composing `encodeTilePayload` + `writeTileIntoCells`. */
export function encodeTileIntoCells(fullCells: Uint8Array, spec: GridSpec, layout: TileGridLayout, tile: TilePayload): void {
  writeTileIntoCells(fullCells, spec, layout, tile.tileIndex, encodeTilePayload(tile));
}

/** Convenience composing `readTileFromCells` + `decodeTilePayload`. */
export function decodeTileFromCells(fullCells: Uint8Array, spec: GridSpec, layout: TileGridLayout, tileIndex: number): TilePayload | null {
  return decodeTilePayload(readTileFromCells(fullCells, spec, layout, tileIndex));
}
