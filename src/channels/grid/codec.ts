import { crc32 } from '../../core/crc32';
import { geometryFor, type GridSpec } from './spec';

/**
 * Frame body <-> cell colours.
 *
 * A frame is `[CRC-32 of everything after it][packet bytes][zero padding]`. The CRC
 * matters more here than it looks: a fountain drop that arrives silently corrupted
 * would poison the reconstruction beyond repair, whereas a *detected* bad frame
 * costs nothing at all — the decoder simply waits for the next one.
 */

/** Exported for reuse by tiles.ts, which packs a much smaller per-tile byte
 * range into its own sub-rectangle of cells using the exact same scheme. */
export function readBits(bytes: Uint8Array, bitOffset: number, count: number): number {
  let value = 0;
  for (let i = 0; i < count; i++) {
    const bit = bitOffset + i;
    const byte = bit >> 3 < bytes.length ? bytes[bit >> 3] : 0;
    value = (value << 1) | ((byte >> (7 - (bit & 7))) & 1);
  }
  return value;
}

export function writeBits(bytes: Uint8Array, bitOffset: number, count: number, value: number): void {
  for (let i = 0; i < count; i++) {
    const bit = bitOffset + i;
    const index = bit >> 3;
    if (index >= bytes.length) return;
    const mask = 1 << (7 - (bit & 7));
    if ((value >> (count - 1 - i)) & 1) bytes[index] |= mask;
    else bytes[index] &= ~mask;
  }
}

/** One colour index per data cell. */
export function encodeGridCells(body: Uint8Array, spec: GridSpec): Uint8Array {
  const geometry = geometryFor(spec);
  if (body.length > geometry.bodyBytes) throw new Error('Frame-Inhalt passt nicht ins Raster');

  const frame = new Uint8Array(geometry.capacityBytes);
  frame.set(body, 4);
  new DataView(frame.buffer).setUint32(0, crc32(frame.subarray(4)), false);

  const bits = spec.palette.bitsPerCell;
  const cells = new Uint8Array(geometry.cellCount);
  for (let i = 0; i < cells.length; i++) cells[i] = readBits(frame, i * bits, bits);
  return cells;
}

/** Returns the frame body, or null when the CRC says the read was garbled. */
export function decodeGridCells(cells: Uint8Array, spec: GridSpec): Uint8Array | null {
  const geometry = geometryFor(spec);
  if (cells.length !== geometry.cellCount) return null;

  const bits = spec.palette.bitsPerCell;
  const frame = new Uint8Array(geometry.capacityBytes);
  for (let i = 0; i < cells.length; i++) writeBits(frame, i * bits, bits, cells[i]);

  const expected = new DataView(frame.buffer).getUint32(0, false);
  const body = frame.subarray(4);
  return crc32(body) === expected ? body : null;
}
