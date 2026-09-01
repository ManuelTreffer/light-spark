/**
 * Protocol v2 core types — the versioned binary format for block-based,
 * resumable transfers (see docs/protocol-v2.md).
 *
 * No DOM dependencies anywhere in `protocol/`: this module must stay usable
 * from a Web Worker and from Node-based tests alike, matching the same
 * discipline `core/packet.ts` and `core/protocol.ts` already follow.
 *
 * v1 (`core/packet.ts`, `core/protocol.ts`) is untouched by this module and
 * keeps working exactly as before — v2 is additive, not a replacement.
 */

/** "LS", big-endian uint16. Distinct from v1's single-byte 0xA7 packet magic,
 * so a receiver can safely try v2 first and fall back to v1 with no ambiguity. */
export const PROTOCOL_MAGIC = 0x4c53;

/** Only version currently defined. A decoder rejects any other value outright
 * rather than guessing at a layout — see docs/protocol-v2.md §2. */
export const PROTOCOL_VERSION = 2;

/** 128 bits, per the roadmap's explicit "mindestens 128 Bit" requirement. */
export const TRANSFER_ID_BYTES = 16;

/** magic(2) + protocolVersion(1) + frameType(1) + flags(1) + transferId(16) + sequenceNumber(4) + payloadLength(2). */
export const COMMON_HEADER_SIZE = 27;

/** blockIndex(4) + blockSourceChunkCount(2) + dropletSeed(4) + dropletDegree(1). */
export const DATA_HEADER_SIZE = 11;

/** SHA-256 digest size. */
export const FILE_HASH_BYTES = 32;

/**
 * Field caps for the wire-transmitted manifest — see docs/protocol-v2.md §5
 * for the QR/Grid capacity arithmetic these are sized against. The *local*
 * UI is free to show the untruncated name; only the bytes actually put on
 * the wire are capped here.
 */
export const MAX_FILE_NAME_BYTES = 44;
export const MAX_MIME_TYPE_BYTES = 32;

/** Above this, a manifest (and any block/transfer referencing it) is rejected
 * outright — see docs/protocol-v2.md §6.6. A proposed, documented ceiling,
 * not (yet) a benchmarked one. */
export const MAX_TRANSFER_BYTES = 256 * 1024 * 1024;

/** uint16 ceilings — named for documentation clarity even though they equal
 * the field's natural maximum representable value. */
export const MAX_BLOCK_COUNT = 0xffff;
export const MAX_BLOCK_SOURCE_CHUNK_COUNT = 0xffff;

/** uint8 ceiling — also doubles as the Fountain layer's max-degree cap
 * (Milestone 3.4's decoder protection), enforced structurally by the wire
 * format itself rather than only by a runtime check. */
export const MAX_DROPLET_DEGREE = 0xff;

export enum FrameType {
  Manifest = 1,
  Data = 2,
  /** Reserved — not sent by this version. Recognised so its numeric value
   * never gets reassigned, but no encoder/decoder handles its payload yet. */
  BlockComplete = 3,
  /** Reserved — not sent by this version (Milestone 2). */
  TransferComplete = 4,
  /** Reserved — not sent by this version (Milestone 6+). */
  Capability = 5,
  /** Reserved — not sent by this version (Milestone 10). */
  Feedback = 6,
}

const KNOWN_FRAME_TYPES: ReadonlySet<number> = new Set([
  FrameType.Manifest,
  FrameType.Data,
  FrameType.BlockComplete,
  FrameType.TransferComplete,
  FrameType.Capability,
  FrameType.Feedback,
]);

/** A truly unknown frameType byte is rejected (not just "no handler") — see
 * docs/protocol-v2.md §2 for why frame types aren't designed to be
 * forward-compatible the way flag bits are. */
export function isKnownFrameType(value: number): value is FrameType {
  return KNOWN_FRAME_TYPES.has(value);
}

/** Bit 0 of CommonFrameHeader.flags. Bits 1-7 are reserved: must be 0 on
 * send, must be ignored (not rejected) on receive — see docs/protocol-v2.md §2. */
export const FLAG_SYSTEMATIC = 0x01;

export interface CommonFrameHeader {
  readonly protocolVersion: number;
  readonly frameType: FrameType;
  readonly flags: number;
  /** 16 random bytes, generated once per transfer by the sender (see transferId.ts). */
  readonly transferId: Uint8Array;
  /** Counts *all* frames (any type) sent by this sender instance, for de-duplication and future feedback references. */
  readonly sequenceNumber: number;
  /** Length, in bytes, of whatever follows this header. */
  readonly payloadLength: number;
}

export interface DataFrameHeader {
  readonly blockIndex: number;
  /** Number of source chunks in *this* block — blocks may differ (the last one is typically shorter). */
  readonly blockSourceChunkCount: number;
  /** PRNG input for `pickIndices(dropletSeed, blockSourceChunkCount)` — same role as v1's `seed`. */
  readonly dropletSeed: number;
  /** Included even though a correct receiver could recompute it deterministically from `dropletSeed` —
   * lets a receiver reject a corrupted header cheaply, before running the (more expensive) chunk-selection PRNG. */
  readonly dropletDegree: number;
}

/**
 * `deflate` means `deflate-raw` via `CompressionStream`/`DecompressionStream`,
 * matching the already-shipped v1 implementation (`core/protocol.ts`) — not
 * real gzip, which would add ~18 bytes of header/footer overhead for no
 * benefit in an always-both-ends-are-this-app scenario. Named `deflate` here
 * to say what it actually is, a deliberate deviation from the roadmap's
 * literal `"gzip"` sketch (see docs/protocol-v2.md §6.3).
 */
export type CompressionAlgorithm = 'none' | 'deflate';

/** Only `sha256` is defined for v2.0. The field exists for a hypothetical
 * future algorithm, not to make hashing optional — every v2 manifest carries
 * a SHA-256 of the original file. */
export type HashAlgorithm = 'sha256';

/**
 * Logical transfer manifest. `transferId` and `protocolVersion` are part of
 * this interface for symmetry with the roadmap's sketch and for convenience
 * at call sites, but are **not** duplicated on the wire — see `manifest.ts`:
 * both already travel once, in the wrapping `CommonFrameHeader`.
 */
export interface TransferManifest {
  readonly protocolVersion: number;
  readonly transferId: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
  /** Bytes, pre-compression. */
  readonly originalSize: number;
  /** Bytes, post-compression (equal to originalSize when compression is 'none'). */
  readonly encodedSize: number;
  /** Bytes per block, before the last (possibly shorter) block. */
  readonly blockSize: number;
  readonly blockCount: number;
  /** Fountain source-chunk size within a block. */
  readonly sourceChunkSize: number;
  readonly compression: CompressionAlgorithm;
  readonly fileHashAlgorithm: HashAlgorithm;
  /** SHA-256 digest of the *original* (pre-compression) file. */
  readonly fileHash: Uint8Array;
  /** Informative only — never used in any validity check. Unix seconds. */
  readonly createdAt?: number;
}

/**
 * What actually goes on the wire for a Manifest frame's payload —
 * `transferId` and `protocolVersion` are already in the wrapping
 * `CommonFrameHeader` and are not repeated here. A higher layer combines
 * `CommonFrameHeader.transferId` + `CommonFrameHeader.protocolVersion` +
 * a decoded `ManifestPayload` into a full `TransferManifest`.
 */
export type ManifestPayload = Omit<TransferManifest, 'transferId' | 'protocolVersion'>;
