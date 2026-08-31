import { crc32 } from './crc32';

/**
 * The envelope: what actually gets fountain-coded and beamed across.
 *
 *   offset  size  field
 *   0       4     magic "LSPK"
 *   4       1     version
 *   5       1     flags (bit 0: payload is raw-deflate compressed)
 *   6       2     name length
 *   8       2     mime length
 *   10      4     original data length
 *   14      4     CRC-32 of the original data
 *   18      ..    name (utf-8), mime (utf-8), payload
 *
 * The CRC covers the *uncompressed* bytes, so it verifies the whole pipeline —
 * camera, decoder, fountain reassembly and inflate — in one check.
 */

const MAGIC = [0x4c, 0x53, 0x50, 0x4b]; // "LSPK"
const VERSION = 1;
const HEADER_SIZE = 18;
const FLAG_COMPRESSED = 0x01;

export interface Payload {
  name: string;
  mime: string;
  data: Uint8Array;
}

async function pipeThrough(bytes: Uint8Array, transform: GenericTransformStream): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(bytes, new CompressionStream('deflate-raw'));
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(bytes, new DecompressionStream('deflate-raw'));
}

export async function buildEnvelope(payload: Payload): Promise<Uint8Array> {
  const name = new TextEncoder().encode(payload.name.slice(0, 200));
  const mime = new TextEncoder().encode(payload.mime.slice(0, 120));

  // Already-compressed formats (jpeg, png, mp3) come back bigger; only pay the
  // deflate cost when it actually buys airtime.
  let body = payload.data;
  let flags = 0;
  try {
    const squeezed = await deflate(payload.data);
    if (squeezed.length < payload.data.length) {
      body = squeezed;
      flags |= FLAG_COMPRESSED;
    }
  } catch {
    /* no CompressionStream — send it raw */
  }

  const out = new Uint8Array(HEADER_SIZE + name.length + mime.length + body.length);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  out[5] = flags;
  view.setUint16(6, name.length, false);
  view.setUint16(8, mime.length, false);
  view.setUint32(10, payload.data.length, false);
  view.setUint32(14, crc32(payload.data), false);
  out.set(name, HEADER_SIZE);
  out.set(mime, HEADER_SIZE + name.length);
  out.set(body, HEADER_SIZE + name.length + mime.length);
  return out;
}

export interface ReceivedPayload extends Payload {
  /** False when the CRC-32 disagrees — the bytes arrived but something mangled them. */
  verified: boolean;
}

export async function parseEnvelope(bytes: Uint8Array): Promise<ReceivedPayload | null> {
  if (bytes.length < HEADER_SIZE) return null;
  if (MAGIC.some((b, i) => bytes[i] !== b)) return null;
  if (bytes[4] !== VERSION) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[5];
  const nameLen = view.getUint16(6, false);
  const mimeLen = view.getUint16(8, false);
  const dataLen = view.getUint32(10, false);
  const expectedCrc = view.getUint32(14, false);

  const nameEnd = HEADER_SIZE + nameLen;
  const mimeEnd = nameEnd + mimeLen;
  if (mimeEnd > bytes.length) return null;

  const decoder = new TextDecoder();
  const name = decoder.decode(bytes.subarray(HEADER_SIZE, nameEnd));
  const mime = decoder.decode(bytes.subarray(nameEnd, mimeEnd));

  let data = bytes.subarray(mimeEnd);
  if (flags & FLAG_COMPRESSED) {
    try {
      data = await inflate(data);
    } catch {
      return { name, mime, data: new Uint8Array(0), verified: false };
    }
  }
  if (data.length !== dataLen) return { name, mime, data, verified: false };

  return { name, mime, data, verified: crc32(data) === expectedCrc };
}

export function payloadFromText(text: string): Payload {
  return {
    name: 'nachricht.txt',
    mime: 'text/plain;charset=utf-8',
    data: new TextEncoder().encode(text),
  };
}

export async function payloadFromFile(file: File): Promise<Payload> {
  return {
    name: file.name,
    mime: file.type || 'application/octet-stream',
    data: new Uint8Array(await file.arrayBuffer()),
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '–';
  if (seconds < 60) return `${Math.ceil(seconds)} s`;
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.round(seconds - m * 60)).padStart(2, '0')} min`;
}
