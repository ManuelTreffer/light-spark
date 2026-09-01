import { TRANSFER_ID_BYTES } from './types';

/**
 * A fresh, random transfer identifier. Not a secret and not a cryptographic
 * boundary — it only needs to disambiguate concurrent/sequential transfers
 * for Resume (Milestone 4) and de-duplication, so `crypto.getRandomValues`
 * is used for its quality of randomness, not for any confidentiality property.
 */
export function generateTransferId(): Uint8Array {
  const id = new Uint8Array(TRANSFER_ID_BYTES);
  crypto.getRandomValues(id);
  return id;
}

export function transferIdsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Lowercase hex, for logs, storage keys, and the UI's "shortened" display. */
export function transferIdToHex(id: Uint8Array): string {
  let out = '';
  for (const byte of id) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Inverse of `transferIdToHex` — used by `storage/` to reconstruct a
 * `TransferManifest.transferId` from an IndexedDB record's string key.
 * Returns `null` for anything that isn't exactly `TRANSFER_ID_BYTES` bytes
 * of valid hex, rather than throwing — storage records are trusted less
 * than in-memory values, since they've round-tripped through a database. */
export function transferIdFromHex(hex: string): Uint8Array | null {
  if (hex.length !== TRANSFER_ID_BYTES * 2 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const id = new Uint8Array(TRANSFER_ID_BYTES);
  for (let i = 0; i < TRANSFER_ID_BYTES; i++) {
    id[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return id;
}
