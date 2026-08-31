/**
 * Base45 (RFC 9285). Every output character lives in QR's alphanumeric set, which
 * costs 5.5 bits per character instead of byte mode's 8 — so 2 bytes ride in 16.5
 * bits rather than base64's 21.3. That is roughly a third more payload per QR frame,
 * and it dodges the mojibake you get from pulling raw binary back out of a decoder
 * that hands you a string.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

const REVERSE = (() => {
  const map = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) map[ALPHABET.charCodeAt(i)] = i;
  return map;
})();

export function base45Encode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 1 < bytes.length; i += 2) {
    let n = bytes[i] * 256 + bytes[i + 1];
    const c = n % 45;
    n = (n - c) / 45;
    const d = n % 45;
    const e = (n - d) / 45;
    out += ALPHABET[c] + ALPHABET[d] + ALPHABET[e];
  }
  if (i < bytes.length) {
    const n = bytes[i];
    out += ALPHABET[n % 45] + ALPHABET[(n - (n % 45)) / 45];
  }
  return out;
}

/** Returns null for anything that is not well-formed base45 — a garbled scan, usually. */
export function base45Decode(text: string): Uint8Array | null {
  const rest = text.length % 3;
  if (rest === 1) return null;

  const values = new Array<number>(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const v = code < 128 ? REVERSE[code] : -1;
    if (v < 0) return null;
    values[i] = v;
  }

  const out = new Uint8Array(Math.floor(text.length / 3) * 2 + (rest === 2 ? 1 : 0));
  let o = 0;
  let i = 0;
  for (; i + 2 < values.length; i += 3) {
    const n = values[i] + values[i + 1] * 45 + values[i + 2] * 45 * 45;
    if (n > 0xffff) return null;
    out[o++] = n >>> 8;
    out[o++] = n & 0xff;
  }
  if (rest === 2) {
    const n = values[i] + values[i + 1] * 45;
    if (n > 0xff) return null;
    out[o++] = n;
  }
  return out;
}
