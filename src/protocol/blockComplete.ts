import { crc32 } from '../core/crc32';

/**
 * Payload of a `FrameType.BlockComplete` frame (Milestone 2.5 — block
 * integrity). Introduced in PR 2: `docs/protocol-v2.md`'s original PR 1 draft
 * left this frame type reserved-but-unspecified; see
 * `docs/adr/0004-block-integrity-via-crc.md` for why this landed as a small,
 * separately-sent CRC-32 rather than growing the manifest with a
 * `blockHashes` array (manifest field budget is already tight — see
 * `docs/protocol-v2.md` §5) or waiting for full SHA-256 (Milestone 8, not
 * yet implemented).
 *
 * The sender computes this once per block (it already has the block's true
 * bytes) and repeats it cyclically, the same way Manifest frames repeat —
 * so a receiver that starts mid-block-transmission, or loses a few of these
 * frames, still gets one eventually. A block is only ever reported
 * `'verified'` once its Fountain-reconstructed bytes match this CRC — see
 * `ReceiverSession` in `transfer/receiverSession.ts`.
 */
export interface BlockCompletePayload {
  readonly blockIndex: number;
  /** CRC-32 (IEEE), over this block's reconstructed source bytes only —
   * the same algorithm already used throughout this codebase (Grid frames,
   * the v1 envelope), not a new primitive. */
  readonly blockCrc32: number;
}

/** blockIndex(4) + blockCrc32(4). */
export const BLOCK_COMPLETE_PAYLOAD_SIZE = 8;

export function encodeBlockComplete(payload: BlockCompletePayload): Uint8Array {
  const out = new Uint8Array(BLOCK_COMPLETE_PAYLOAD_SIZE);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.blockIndex, false);
  view.setUint32(4, payload.blockCrc32, false);
  return out;
}

export function decodeBlockComplete(bytes: Uint8Array): BlockCompletePayload | null {
  if (bytes.length < BLOCK_COMPLETE_PAYLOAD_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    blockIndex: view.getUint32(0, false),
    blockCrc32: view.getUint32(4, false),
  };
}

/** Convenience used identically by the sender (to announce) and the
 * receiver (to verify) — both must agree on what "this block's CRC" means. */
export function crc32OfBlock(blockBytes: Uint8Array): number {
  return crc32(blockBytes);
}
