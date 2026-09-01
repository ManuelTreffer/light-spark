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
