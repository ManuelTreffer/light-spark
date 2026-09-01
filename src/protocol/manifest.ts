import {
  FILE_HASH_BYTES,
  MAX_BLOCK_COUNT,
  MAX_BLOCK_SOURCE_CHUNK_COUNT,
  MAX_FILE_NAME_BYTES,
  MAX_MIME_TYPE_BYTES,
  MAX_TRANSFER_BYTES,
  type CompressionAlgorithm,
  type HashAlgorithm,
  type ManifestPayload,
} from './types';

/**
 * Binary (de)serialization for the Manifest frame payload. See
 * docs/protocol-v2.md §4-5 for the field layout and the capacity arithmetic
 * that the MAX_FILE_NAME_BYTES/MAX_MIME_TYPE_BYTES caps are sized against.
 *
 * `fileName`/`mimeType` are truncated by the *caller*, not silently here —
 * encodeManifest throws rather than truncating, so a codec bug never turns
 * into silent data loss. Truncation (if wanted) belongs in the sender-side
 * session logic that has UI context, per the "codec/protocol modules stay
 * free of UI concerns" rule.
 */

const COMPRESSION_CODE: Record<CompressionAlgorithm, number> = { none: 0, deflate: 1 };
const COMPRESSION_BY_CODE: readonly (CompressionAlgorithm | undefined)[] = [
  'none', // 0
  'deflate', // 1
];

const HASH_ALGORITHM_CODE: Record<HashAlgorithm, number> = { sha256: 1 };
const HASH_ALGORITHM_BY_CODE: readonly (HashAlgorithm | undefined)[] = [
  undefined, // 0 — reserved/invalid; a v2 manifest always carries a real hash
  'sha256', // 1
];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Fixed-size fields after the two length-prefixed strings: originalSize(4) +
 * encodedSize(4) + blockSize(4) + blockCount(2) + sourceChunkSize(2) +
 * compression(1) + fileHashAlgorithm(1) + fileHash(32) + createdAtPresent(1). */
const FIXED_TAIL_SIZE = 4 + 4 + 4 + 2 + 2 + 1 + 1 + FILE_HASH_BYTES + 1;

export function encodeManifest(manifest: ManifestPayload): Uint8Array {
  const nameBytes = textEncoder.encode(manifest.fileName);
  if (nameBytes.length > MAX_FILE_NAME_BYTES) {
    throw new Error(`fileName exceeds ${MAX_FILE_NAME_BYTES} UTF-8 bytes (got ${nameBytes.length}) — truncate before encoding`);
  }
  const mimeBytes = textEncoder.encode(manifest.mimeType);
  if (mimeBytes.length > MAX_MIME_TYPE_BYTES) {
    throw new Error(`mimeType exceeds ${MAX_MIME_TYPE_BYTES} UTF-8 bytes (got ${mimeBytes.length})`);
  }
  if (manifest.originalSize > MAX_TRANSFER_BYTES || manifest.encodedSize > MAX_TRANSFER_BYTES) {
    throw new Error(`transfer size exceeds MAX_TRANSFER_BYTES (${MAX_TRANSFER_BYTES})`);
  }
  if (manifest.blockSize <= 0) throw new Error('blockSize must be positive');
  if (manifest.blockCount < 1 || manifest.blockCount > MAX_BLOCK_COUNT) {
    throw new Error(`blockCount ${manifest.blockCount} out of range`);
  }
  if (manifest.sourceChunkSize <= 0 || manifest.sourceChunkSize > MAX_BLOCK_SOURCE_CHUNK_COUNT) {
    throw new Error(`sourceChunkSize ${manifest.sourceChunkSize} out of range`);
  }
  if (manifest.fileHash.length !== FILE_HASH_BYTES) {
    throw new Error(`fileHash must be ${FILE_HASH_BYTES} bytes (SHA-256), got ${manifest.fileHash.length}`);
  }

  const hasCreatedAt = manifest.createdAt !== undefined;
  const size = 1 + nameBytes.length + 1 + mimeBytes.length + FIXED_TAIL_SIZE + (hasCreatedAt ? 4 : 0);

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;

  out[offset] = nameBytes.length;
  offset += 1;
  out.set(nameBytes, offset);
  offset += nameBytes.length;

  out[offset] = mimeBytes.length;
  offset += 1;
  out.set(mimeBytes, offset);
  offset += mimeBytes.length;

  view.setUint32(offset, manifest.originalSize, false);
  offset += 4;
  view.setUint32(offset, manifest.encodedSize, false);
  offset += 4;
  view.setUint32(offset, manifest.blockSize, false);
  offset += 4;
  view.setUint16(offset, manifest.blockCount, false);
  offset += 2;
  view.setUint16(offset, manifest.sourceChunkSize, false);
  offset += 2;
  out[offset] = COMPRESSION_CODE[manifest.compression];
  offset += 1;
  out[offset] = HASH_ALGORITHM_CODE[manifest.fileHashAlgorithm];
  offset += 1;
  out.set(manifest.fileHash, offset);
  offset += FILE_HASH_BYTES;
  out[offset] = hasCreatedAt ? 1 : 0;
  offset += 1;
  if (hasCreatedAt) {
    view.setUint32(offset, manifest.createdAt!, false);
    offset += 4;
  }

  return out;
}

/** Returns null for anything that isn't a plausible manifest — truncated,
 * corrupted, or claiming values outside the documented ranges. Nothing is
 * allocated or trusted before its declared length is checked against what
 * the buffer actually contains. */
export function decodeManifest(bytes: Uint8Array): ManifestPayload | null {
  let offset = 0;
  const remaining = () => bytes.length - offset;

  if (remaining() < 1) return null;
  const nameLen = bytes[offset];
  offset += 1;
  if (nameLen > MAX_FILE_NAME_BYTES || remaining() < nameLen) return null;
  const fileName = textDecoder.decode(bytes.subarray(offset, offset + nameLen));
  offset += nameLen;

  if (remaining() < 1) return null;
  const mimeLen = bytes[offset];
  offset += 1;
  if (mimeLen > MAX_MIME_TYPE_BYTES || remaining() < mimeLen) return null;
  const mimeType = textDecoder.decode(bytes.subarray(offset, offset + mimeLen));
  offset += mimeLen;

  if (remaining() < FIXED_TAIL_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const originalSize = view.getUint32(offset, false);
  offset += 4;
  const encodedSize = view.getUint32(offset, false);
  offset += 4;
  if (originalSize > MAX_TRANSFER_BYTES || encodedSize > MAX_TRANSFER_BYTES) return null;

  const blockSize = view.getUint32(offset, false);
  offset += 4;
  if (blockSize === 0) return null;

  const blockCount = view.getUint16(offset, false);
  offset += 2;
  // Never trust a declared blockCount blindly — recompute it the same way
  // the sender is expected to, and reject any mismatch. Mirrors
  // FountainEncoder's own "at least one chunk, even for an empty payload"
  // convention (Math.max(1, Math.ceil(...))).
  const expectedBlockCount = Math.max(1, Math.ceil(encodedSize / blockSize));
  if (blockCount !== expectedBlockCount) return null;

  const sourceChunkSize = view.getUint16(offset, false);
  offset += 2;
  if (sourceChunkSize === 0) return null;

  const compression = COMPRESSION_BY_CODE[bytes[offset]];
  offset += 1;
  if (!compression) return null;

  const fileHashAlgorithm = HASH_ALGORITHM_BY_CODE[bytes[offset]];
  offset += 1;
  if (!fileHashAlgorithm) return null;

  const fileHash = bytes.slice(offset, offset + FILE_HASH_BYTES);
  offset += FILE_HASH_BYTES;

  const createdAtPresent = bytes[offset];
  offset += 1;
  if (createdAtPresent !== 0 && createdAtPresent !== 1) return null;

  let createdAt: number | undefined;
  if (createdAtPresent === 1) {
    if (remaining() < 4) return null;
    createdAt = view.getUint32(offset, false);
    offset += 4;
  }

  return {
    fileName,
    mimeType,
    originalSize,
    encodedSize,
    blockSize,
    blockCount,
    sourceChunkSize,
    compression,
    fileHashAlgorithm,
    fileHash,
    createdAt,
  };
}
