import { MAX_BLOCK_COUNT, MAX_TRANSFER_BYTES, type TransferManifest } from '../protocol/types';

/**
 * Starting block-size profiles (Milestone 2.1). Proposals, not benchmarked —
 * see docs/architecture-audit.md §11 item 5: a 4 MiB block on Grid-safe's
 * ~1.3 KB/s would take over 50 minutes just for one block's systematic pass.
 * Kept configurable (BlockPlan takes a raw byte count, not a profile name) so
 * real measurement can drive the actual default later without a wire-format
 * or API change.
 */
export const BLOCK_PROFILES = {
  small: 256 * 1024,
  balanced: 1024 * 1024,
  large: 4 * 1024 * 1024,
} as const;

export interface BlockRange {
  readonly offset: number;
  readonly length: number;
}

export interface BlockPlan {
  readonly totalBytes: number;
  readonly blockSize: number;
  readonly blockCount: number;
  getBlockRange(blockIndex: number): BlockRange;
}

/**
 * `Blob.slice()` (or `Uint8Array.subarray()`, for data already in memory) is
 * what actually extracts a block's bytes — this only computes the offsets,
 * so no full copy of the file happens per block just to plan the split.
 */
export function createBlockPlan(totalBytes: number, blockSize: number): BlockPlan {
  if (blockSize <= 0) throw new Error(`blockSize must be positive, got ${blockSize}`);
  if (totalBytes < 0) throw new Error(`totalBytes must not be negative, got ${totalBytes}`);

  // Mirrors FountainEncoder's and manifest.ts's own convention: an empty
  // file is still exactly one block, of length 0 — never zero blocks.
  const blockCount = Math.max(1, Math.ceil(totalBytes / blockSize));

  return {
    totalBytes,
    blockSize,
    blockCount,
    getBlockRange(blockIndex: number): BlockRange {
      if (blockIndex < 0 || blockIndex >= blockCount) {
        throw new Error(`blockIndex ${blockIndex} out of range [0, ${blockCount})`);
      }
      const offset = blockIndex * blockSize;
      // The last block is shorter whenever totalBytes isn't an exact multiple
      // of blockSize (Milestone 2.1's "letzter Block darf kleiner sein").
      const length = Math.max(0, Math.min(blockSize, totalBytes - offset));
      return { offset, length };
    },
  };
}

/**
 * Builds a `BlockPlan` from an already-decoded, already-validated manifest —
 * used on the receiving end, where `blockSize`/`blockCount` are attacker-
 * controlled values that arrived over the air. `manifest.ts`'s `decodeManifest`
 * already checks internal consistency (`blockCount` matches
 * `ceil(encodedSize / blockSize)`) before ever returning a `ManifestPayload`,
 * but this is validated again here as a second, independent layer at the
 * actual point of use — cheap, and "Validiere Größen und Indizes vor jeder
 * Allokation" applies at every allocation site, not just at decode time.
 * Returns `null`, never throws, for anything inconsistent or out of range.
 */
export function createBlockPlanFromManifest(
  manifest: Pick<TransferManifest, 'encodedSize' | 'blockSize' | 'blockCount'>,
): BlockPlan | null {
  if (manifest.blockSize <= 0 || manifest.blockSize > MAX_TRANSFER_BYTES) return null;
  if (manifest.blockCount < 1 || manifest.blockCount > MAX_BLOCK_COUNT) return null;
  if (manifest.encodedSize < 0 || manifest.encodedSize > MAX_TRANSFER_BYTES) return null;

  const plan = createBlockPlan(manifest.encodedSize, manifest.blockSize);
  if (plan.blockCount !== manifest.blockCount) return null;
  return plan;
}
