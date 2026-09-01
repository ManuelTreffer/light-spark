import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../../core/rng';
import {
  tileLayoutFor,
  encodeTilePayload,
  decodeTilePayload,
  writeTileIntoCells,
  encodeTileIntoCells,
  decodeTileFromCells,
  TILE_HEADER_SIZE,
  TILE_CRC_SIZE,
  type TilePayload,
} from './tiles';
import { GRID_PRESETS, specFor, geometryFor } from './spec';

function randomBytes(n: number, seed: number): Uint8Array {
  const rand = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

const normalSpec = specFor(GRID_PRESETS.find((p) => p.id === 'normal')!);
const safeSpec = specFor(GRID_PRESETS.find((p) => p.id === 'safe')!);

describe('tileLayoutFor — geometry', () => {
  it('covers every data cell exactly once across all tiles', () => {
    const spec = normalSpec;
    const geometry = geometryFor(spec);
    const layout = tileLayoutFor(spec, 3, 3);
    expect(layout.tileCount).toBe(9);

    const covered = new Array(geometry.dataRows.length * spec.cells).fill(0);
    for (let i = 0; i < layout.tileCount; i++) {
      const rect = layout.tileRect(i);
      for (let r = 0; r < rect.rowCount; r++) {
        for (let c = 0; c < rect.colCount; c++) {
          const index = (rect.rowStart + r) * spec.cells + (rect.colStart + c);
          covered[index]++;
        }
      }
    }
    expect(covered.every((n) => n === 1)).toBe(true);
  });

  it('handles a data area that does not divide evenly into the requested tiling', () => {
    const spec = safeSpec; // 26 data rows, 28 cols — doesn't divide evenly into e.g. 4x4
    const layout = tileLayoutFor(spec, 4, 4);
    let totalCells = 0;
    for (let i = 0; i < layout.tileCount; i++) {
      const rect = layout.tileRect(i);
      expect(rect.rowCount).toBeGreaterThan(0);
      expect(rect.colCount).toBeGreaterThan(0);
      totalCells += rect.rowCount * rect.colCount;
    }
    const geometry = geometryFor(spec);
    expect(totalCells).toBe(geometry.dataRows.length * spec.cells);
  });

  it('rejects a tiling denser than the data area can support', () => {
    const spec = safeSpec;
    const geometry = geometryFor(spec);
    expect(() => tileLayoutFor(spec, geometry.dataRows.length + 1, 1)).toThrow();
  });

  it('tileRect rejects an out-of-range index', () => {
    const layout = tileLayoutFor(normalSpec, 2, 2);
    expect(() => layout.tileRect(-1)).toThrow();
    expect(() => layout.tileRect(layout.tileCount)).toThrow();
  });
});

function samplePayload(tileIndex: number, tileSequence: number, tileCount: number, fragmentOffset: number, fragment: Uint8Array): TilePayload {
  return { tileIndex, tileSequence, tileCount, fragmentOffset, fragmentLength: fragment.length, fragment };
}

describe('Tile payload — golden vector', () => {
  // Hand-computed, not round-tripped through the encoder.
  //
  //   offset  bytes       field
  //   0       02          tileIndex = 2
  //   1       05          tileSequence = 5
  //   2       04          tileCount = 4
  //   3       00 03       fragmentOffset = 3
  //   5       00 02       fragmentLength = 2
  //   7       AA BB       fragment
  //   9       <4-byte CRC-32 over bytes 0..8>
  it('encodes to the expected header layout, decodes back identically', () => {
    const tile = samplePayload(2, 5, 4, 3, new Uint8Array([0xaa, 0xbb]));
    const encoded = encodeTilePayload(tile);

    expect(encoded.length).toBe(TILE_HEADER_SIZE + 2 + TILE_CRC_SIZE);
    expect(Array.from(encoded.subarray(0, TILE_HEADER_SIZE + 2))).toEqual([0x02, 0x05, 0x04, 0x00, 0x03, 0x00, 0x02, 0xaa, 0xbb]);

    const decoded = decodeTilePayload(encoded);
    expect(decoded).toEqual(tile);
  });
});

describe('Tile payload — rejects', () => {
  it('a truncated buffer', () => {
    const tile = samplePayload(0, 0, 1, 0, new Uint8Array([1, 2, 3]));
    const encoded = encodeTilePayload(tile);
    for (let cut = 0; cut < encoded.length; cut++) {
      expect(decodeTilePayload(encoded.subarray(0, cut)), `cut at ${cut}`).toBeNull();
    }
  });

  it('a corrupted byte anywhere in the header or fragment', () => {
    const tile = samplePayload(1, 2, 3, 0, new Uint8Array([9, 9, 9, 9]));
    const encoded = encodeTilePayload(tile);
    for (let i = 0; i < TILE_HEADER_SIZE + tile.fragment.length; i++) {
      const corrupted = encoded.slice();
      corrupted[i] ^= 0xff;
      expect(decodeTilePayload(corrupted), `flipped byte ${i}`).toBeNull();
    }
  });

  it('tileIndex >= tileCount', () => {
    expect(() => encodeTilePayload(samplePayload(3, 0, 3, 0, new Uint8Array(0)))).toThrow();
    // Constructed directly (bypassing the throwing encoder) to hit the decoder's own check.
    const bytes = new Uint8Array(TILE_HEADER_SIZE + TILE_CRC_SIZE);
    bytes[0] = 3; // tileIndex
    bytes[2] = 3; // tileCount — tileIndex must be < tileCount
    expect(decodeTilePayload(bytes)).toBeNull();
  });

  it('tileCount = 0', () => {
    const bytes = new Uint8Array(TILE_HEADER_SIZE + TILE_CRC_SIZE);
    expect(decodeTilePayload(bytes)).toBeNull();
  });
});

describe('Tile <-> cells round-trip', () => {
  it('writes and reads back a tile through a full-size cell array, unaffected by other tiles', () => {
    const spec = normalSpec;
    const layout = tileLayoutFor(spec, 3, 3);
    const geometry = geometryFor(spec);
    const fullCells = new Uint8Array(geometry.dataRows.length * spec.cells);

    const capacity = layout.tileCapacityBytes(4); // centre tile
    const fragment = randomBytes(Math.max(1, capacity - TILE_HEADER_SIZE - TILE_CRC_SIZE), 1);
    const tile: TilePayload = { tileIndex: 4, tileSequence: 7, tileCount: 9, fragmentOffset: 0, fragmentLength: fragment.length, fragment };

    encodeTileIntoCells(fullCells, spec, layout, tile);
    const decoded = decodeTileFromCells(fullCells, spec, layout, 4);
    expect(decoded).toEqual(tile);

    // Every other tile's rectangle is still all zero — writing tile 4 didn't leak into them.
    for (let i = 0; i < layout.tileCount; i++) {
      if (i === 4) continue;
      const rect = layout.tileRect(i);
      for (let r = 0; r < rect.rowCount; r++) {
        for (let c = 0; c < rect.colCount; c++) {
          expect(fullCells[(rect.rowStart + r) * spec.cells + (rect.colStart + c)]).toBe(0);
        }
      }
    }
  });

  it('writeTileIntoCells rejects a payload larger than the tile can hold', () => {
    const spec = safeSpec;
    const layout = tileLayoutFor(spec, 3, 3);
    const capacity = layout.tileCapacityBytes(0);
    expect(() => writeTileIntoCells(new Uint8Array(1000), spec, layout, 0, new Uint8Array(capacity + 1))).toThrow();
  });

  it('reading an all-zero (never-written) tile decodes as null (no accidental valid CRC)', () => {
    const spec = normalSpec;
    const layout = tileLayoutFor(spec, 3, 3);
    const geometry = geometryFor(spec);
    const fullCells = new Uint8Array(geometry.dataRows.length * spec.cells); // all zero
    expect(decodeTileFromCells(fullCells, spec, layout, 0)).toBeNull();
  });
});
