import {
  COMMON_HEADER_SIZE,
  DATA_HEADER_SIZE,
  MAX_BLOCK_SOURCE_CHUNK_COUNT,
  MAX_DROPLET_DEGREE,
  PROTOCOL_MAGIC,
  PROTOCOL_VERSION,
  TRANSFER_ID_BYTES,
  isKnownFrameType,
  type CommonFrameHeader,
  type DataFrameHeader,
} from './types';

/**
 * Binary (de)serialization for `CommonFrameHeader` and `DataFrameHeader`.
 * See docs/protocol-v2.md §2-3 for the field-by-field wire layout and the
 * rationale for every validation rule below. Every decode function returns
 * `null` for anything not a plausible frame — misreads off a camera are
 * routine, matching the existing convention in `core/packet.ts`.
 */

export function encodeCommonFrameHeader(header: CommonFrameHeader): Uint8Array {
  if (header.transferId.length !== TRANSFER_ID_BYTES) {
    throw new Error(`transferId must be ${TRANSFER_ID_BYTES} bytes, got ${header.transferId.length}`);
  }
  if (!isKnownFrameType(header.frameType)) {
    throw new Error(`unknown frameType ${header.frameType}`);
  }
  if (header.payloadLength > 0xffff) {
    throw new Error(`payloadLength ${header.payloadLength} exceeds uint16`);
  }

  const out = new Uint8Array(COMMON_HEADER_SIZE);
  const view = new DataView(out.buffer);
  view.setUint16(0, PROTOCOL_MAGIC, false);
  out[2] = header.protocolVersion;
  out[3] = header.frameType;
  out[4] = header.flags;
  out.set(header.transferId, 5);
  view.setUint32(21, header.sequenceNumber, false);
  view.setUint16(25, header.payloadLength, false);
  return out;
}

export interface DecodedCommonFrameHeader {
  readonly header: CommonFrameHeader;
  /** Offset into the source buffer where the payload begins. Always equal to
   * `COMMON_HEADER_SIZE`; exposed so call sites don't need to import that
   * constant separately just to slice the payload out. */
  readonly payloadOffset: number;
}

export function decodeCommonFrameHeader(bytes: Uint8Array): DecodedCommonFrameHeader | null {
  if (bytes.length < COMMON_HEADER_SIZE) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, false) !== PROTOCOL_MAGIC) return null;

  // Only PROTOCOL_VERSION is defined so far. A future v3 decoder is expected
  // to special-case v2 explicitly, not assume forward compatibility here.
  const protocolVersion = bytes[2];
  if (protocolVersion !== PROTOCOL_VERSION) return null;

  const frameType = bytes[3];
  if (!isKnownFrameType(frameType)) return null;

  const flags = bytes[4];
  // Copy, not a view: transferId is expected to outlive the source buffer
  // (e.g. a transient camera-frame Uint8Array), and it's only 16 bytes.
  const transferId = bytes.slice(5, 5 + TRANSFER_ID_BYTES);
  const sequenceNumber = view.getUint32(21, false);
  const payloadLength = view.getUint16(25, false);

  // The DoS-prevention pattern already shipped in core/packet.ts, generalised:
  // never trust a declared length beyond what the buffer actually backs.
  if (COMMON_HEADER_SIZE + payloadLength > bytes.length) return null;

  return {
    header: { protocolVersion, frameType, flags, transferId, sequenceNumber, payloadLength },
    payloadOffset: COMMON_HEADER_SIZE,
  };
}

export function encodeDataFrameHeader(header: DataFrameHeader): Uint8Array {
  if (header.blockSourceChunkCount === 0 || header.blockSourceChunkCount > MAX_BLOCK_SOURCE_CHUNK_COUNT) {
    throw new Error(`blockSourceChunkCount ${header.blockSourceChunkCount} out of range`);
  }
  if (header.dropletDegree === 0 || header.dropletDegree > MAX_DROPLET_DEGREE) {
    throw new Error(`dropletDegree ${header.dropletDegree} out of range`);
  }

  const out = new Uint8Array(DATA_HEADER_SIZE);
  const view = new DataView(out.buffer);
  view.setUint32(0, header.blockIndex, false);
  view.setUint16(4, header.blockSourceChunkCount, false);
  view.setUint32(6, header.dropletSeed, false);
  out[10] = header.dropletDegree;
  return out;
}

export function decodeDataFrameHeader(bytes: Uint8Array): DataFrameHeader | null {
  if (bytes.length < DATA_HEADER_SIZE) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blockIndex = view.getUint32(0, false);
  const blockSourceChunkCount = view.getUint16(4, false);
  const dropletSeed = view.getUint32(6, false);
  const dropletDegree = bytes[10];

  if (blockSourceChunkCount === 0) return null;
  if (dropletDegree === 0 || dropletDegree > blockSourceChunkCount) return null;

  // A systematic drop (dropletSeed < blockSourceChunkCount) is, by the same
  // convention core/fountain.ts's pickIndices already uses, always the
  // verbatim source chunk at that index — degree 1 by construction. A header
  // claiming otherwise is internally inconsistent and rejected here, before
  // it ever reaches the (more expensive) chunk-selection PRNG.
  if (isSystematic(dropletSeed, blockSourceChunkCount) && dropletDegree !== 1) return null;

  return { blockIndex, blockSourceChunkCount, dropletSeed, dropletDegree };
}

/** `dropletSeed < blockSourceChunkCount` ⇒ this drop *is* source chunk
 * `dropletSeed`, verbatim — no separate wire field needed for it (see
 * docs/protocol-v2.md §3.2 and ADR 0003). */
export function isSystematic(dropletSeed: number, blockSourceChunkCount: number): boolean {
  return dropletSeed < blockSourceChunkCount;
}
