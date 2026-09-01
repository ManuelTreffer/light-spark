import { FountainDecoder } from '../core/fountain';
import { crc32 } from '../core/crc32';
import { decodeBlockComplete } from '../protocol/blockComplete';
import { decodeCommonFrameHeader, decodeDataFrameHeader } from '../protocol/frameHeader';
import { decodeManifest } from '../protocol/manifest';
import { transferIdsEqual, transferIdToHex } from '../protocol/transferId';
import { DATA_HEADER_SIZE, FrameType, type ManifestPayload } from '../protocol/types';
import { createBlockPlanFromManifest, type BlockPlan } from './blockPlan';

/** Milestone 2.4: only this many blocks may have a live `FountainDecoder`
 * (i.e. be `'receiving'`) at once. A block beyond this bound is evicted —
 * its partial progress is discarded, not persisted (persistence is
 * Milestone 4 / PR 3); it simply restarts from scratch if drops for it
 * arrive again later, which they will, since the sender repeats every block
 * cyclically with no back-channel to tell it to stop. */
const DEFAULT_MAX_ACTIVE_BLOCK_DECODERS = 4;

export type BlockStatus = 'missing' | 'receiving' | 'decoded' | 'verified' | 'invalid';

export interface BlockReceiveState {
  readonly blockIndex: number;
  readonly sourceChunkCount: number;
  readonly receivedDropletCount: number;
  readonly uniqueDropletCount: number;
  readonly solvedChunkCount: number;
  readonly status: BlockStatus;
}

export type ManifestStatus = 'missing' | 'partial' | 'valid';
export type SessionStatus = 'discovering' | 'receiving' | 'verifying' | 'completed' | 'failed';

export interface ReceiverSessionState {
  readonly transferId: string;
  readonly manifestStatus: ManifestStatus;
  readonly blocks: readonly BlockReceiveState[];
  readonly validFrames: number;
  readonly rejectedFrames: number;
  readonly duplicateFrames: number;
  readonly status: SessionStatus;
}

interface BlockEntry {
  /** Present only while actively decoding; freed once verified (or, for a
   * block waiting on drops that never resolved, evicted under memory
   * pressure — see DEFAULT_MAX_ACTIVE_BLOCK_DECODERS). */
  decoder: FountainDecoder | null;
  sourceChunkCount: number;
  /** For `uniqueDropletCount` reporting and cheap duplicate detection at
   * this layer — a *block-scoped* set, discarded with the rest of the entry
   * once verified or evicted, not a transfer-wide "every sequence number
   * ever seen" set (see docs/architecture-audit.md §11 item... the
   * "keine unbegrenzten Sets" rule from Milestone 2.4). */
  seenSeeds: Set<number>;
  receivedDropletCount: number;
  status: BlockStatus;
}

/**
 * Consumes raw Protocol v2 frame bytes (as produced by `SenderSession`, or —
 * once a later PR wires this into a real channel — decoded off a QR/Grid
 * stream) and reconstructs the transfer, one independently-verified block at
 * a time. No DOM dependencies: works from a Web Worker or a Node test alike.
 *
 * Deliberately out of scope here (see docs/architecture-audit.md's PR 2
 * plan): no IndexedDB persistence (Milestone 4 / PR 3 — verified blocks are
 * kept in memory, bounded by the manifest's own MAX_TRANSFER_BYTES ceiling,
 * not unboundedly), no file-level SHA-256 verification (Milestone 8 / PR 7 —
 * `manifest.fileHash` is carried through but not yet checked), no manifest
 * conflict UI (Milestone 4.4 — a differing manifest for an in-progress
 * transferId is currently just ignored, never applied over live state).
 */
export class ReceiverSession {
  private readonly maxActiveBlockDecoders: number;

  private transferId: Uint8Array | null = null;
  private manifest: ManifestPayload | null = null;
  private blockPlan: BlockPlan | null = null;

  private readonly blocks = new Map<number, BlockEntry>();
  private readonly completedBlockBytes = new Map<number, Uint8Array>();
  /** blockIndex -> sender-announced CRC-32, from BlockComplete frames.
   * Bounded by blockCount (itself capped at MAX_BLOCK_COUNT), since a Map
   * keyed by blockIndex can never hold more than blockCount entries. */
  private readonly announcedBlockCrc = new Map<number, number>();

  private validFrames = 0;
  private rejectedFrames = 0;
  private duplicateFrames = 0;

  constructor(options: { maxActiveBlockDecoders?: number } = {}) {
    this.maxActiveBlockDecoders = options.maxActiveBlockDecoders ?? DEFAULT_MAX_ACTIVE_BLOCK_DECODERS;
  }

  ingestFrame(bytes: Uint8Array): void {
    const decoded = decodeCommonFrameHeader(bytes);
    if (!decoded) {
      this.rejectedFrames++;
      return;
    }
    const { header, payloadOffset } = decoded;

    if (this.transferId && !transferIdsEqual(this.transferId, header.transferId)) {
      // A frame from a different transfer — ignore rather than mixing two
      // transfers' blocks together. Not "rejected" (it's a perfectly valid
      // frame, just not for this session) and not "duplicate" either; simply
      // not counted, the same way a receiver tuned to one QR stream doesn't
      // count an unrelated code it happens to also see.
      return;
    }

    const payload = bytes.subarray(payloadOffset, payloadOffset + header.payloadLength);

    switch (header.frameType) {
      case FrameType.Manifest:
        this.ingestManifest(header.transferId, payload);
        return;
      case FrameType.Data:
        this.ingestData(payload);
        return;
      case FrameType.BlockComplete:
        this.ingestBlockComplete(payload);
        return;
      default:
        // A structurally valid, recognised frame type (BlockComplete's
        // siblings TransferComplete/Capability/Feedback) that this version
        // simply has no handler for yet — not an error, see
        // docs/protocol-v2.md §3.
        this.validFrames++;
        return;
    }
  }

  private ingestManifest(transferId: Uint8Array, payload: Uint8Array): void {
    const manifest = decodeManifest(payload);
    if (!manifest) {
      this.rejectedFrames++;
      return;
    }

    if (this.manifest) {
      // Same transferId, manifest already known — either an identical
      // cyclic resend (expected, common) or a genuine conflict. Milestone
      // 4.4's full conflict UI/diagnostics lands with persistence (PR 3);
      // for now a conflicting resend is simply never applied over live
      // state, so in-progress blocks can't be silently reinterpreted under
      // a different block layout.
      if (manifestsEqual(this.manifest, manifest)) {
        this.duplicateFrames++;
      } else {
        this.rejectedFrames++;
      }
      return;
    }

    const plan = createBlockPlanFromManifest(manifest);
    if (!plan) {
      // Internally inconsistent (shouldn't happen — decodeManifest already
      // checks this — but never trust a second time less than the first).
      this.rejectedFrames++;
      return;
    }

    this.transferId = transferId;
    this.manifest = manifest;
    this.blockPlan = plan;
    this.validFrames++;
  }

  private ingestData(payload: Uint8Array): void {
    if (!this.blockPlan || !this.manifest) {
      // No manifest yet — a Data frame is meaningless without knowing block
      // boundaries and the Fountain chunk size. Not "rejected": the frame
      // itself may be perfectly well-formed, we just can't use it yet.
      return;
    }

    const dataHeader = decodeDataFrameHeader(payload);
    if (!dataHeader) {
      this.rejectedFrames++;
      return;
    }
    if (dataHeader.blockIndex >= this.blockPlan.blockCount) {
      this.rejectedFrames++;
      return;
    }

    if (this.completedBlockBytes.has(dataHeader.blockIndex)) {
      this.duplicateFrames++;
      return;
    }

    const dropPayload = payload.subarray(DATA_HEADER_SIZE);

    let entry = this.blocks.get(dataHeader.blockIndex);
    if (!entry) {
      this.ensureCapacityForNewBlock();
      entry = {
        decoder: new FountainDecoder(this.blockPlan.getBlockRange(dataHeader.blockIndex).length, this.manifest.sourceChunkSize),
        sourceChunkCount: dataHeader.blockSourceChunkCount,
        seenSeeds: new Set(),
        receivedDropletCount: 0,
        status: 'receiving',
      };
      this.blocks.set(dataHeader.blockIndex, entry);
    } else {
      // Touch for LRU: re-insert at the end so eviction takes the least
      // recently touched block first.
      this.blocks.delete(dataHeader.blockIndex);
      this.blocks.set(dataHeader.blockIndex, entry);
    }

    if (entry.seenSeeds.has(dataHeader.dropletSeed)) {
      this.duplicateFrames++;
      return;
    }
    entry.seenSeeds.add(dataHeader.dropletSeed);
    entry.receivedDropletCount++;
    this.validFrames++;

    entry.decoder!.addDrop(dataHeader.dropletSeed, dropPayload);

    if (entry.decoder!.isComplete) {
      entry.status = 'decoded';
      this.tryFinalizeBlock(dataHeader.blockIndex, entry);
    }
  }

  private ingestBlockComplete(payload: Uint8Array): void {
    if (!this.blockPlan) return; // no manifest yet, block indices are meaningless

    const parsed = decodeBlockComplete(payload);
    if (!parsed) {
      this.rejectedFrames++;
      return;
    }
    if (parsed.blockIndex >= this.blockPlan.blockCount) {
      this.rejectedFrames++;
      return;
    }
    if (this.completedBlockBytes.has(parsed.blockIndex)) {
      this.duplicateFrames++;
      return;
    }
    if (this.announcedBlockCrc.get(parsed.blockIndex) === parsed.blockCrc32) {
      this.duplicateFrames++;
      return;
    }

    this.announcedBlockCrc.set(parsed.blockIndex, parsed.blockCrc32);
    this.validFrames++;

    const entry = this.blocks.get(parsed.blockIndex);
    if (entry?.decoder?.isComplete) this.tryFinalizeBlock(parsed.blockIndex, entry);
  }

  private tryFinalizeBlock(blockIndex: number, entry: BlockEntry): void {
    const announcedCrc = this.announcedBlockCrc.get(blockIndex);
    if (announcedCrc === undefined) return; // decoded, but no CRC to check against yet — stays 'decoded'

    const data = entry.decoder!.getData();
    if (!data) return; // defensive; isComplete already guarantees this is non-null

    if (crc32(data) === announcedCrc) {
      entry.status = 'verified';
      entry.decoder = null; // free the equation-graph memory; only the small entry + final bytes remain
      this.completedBlockBytes.set(blockIndex, data);
      this.blocks.delete(blockIndex);
    } else {
      // A corrupted-but-plausible drop poisoned this block's XOR graph (see
      // docs/architecture-audit.md risk #6 — QR in particular has no
      // per-packet integrity check independent of the frame's own decode).
      // There's no way to isolate which drop was bad after the fact, so the
      // whole block restarts clean: the next drop for it creates a fresh
      // decoder (see ingestData). The 'invalid' status is left visible in
      // state() until that happens, rather than silently reverting to
      // 'missing' as if nothing had gone wrong.
      entry.status = 'invalid';
      entry.decoder = null;
      this.blocks.delete(blockIndex);
    }
  }

  /** Evicts the least-recently-touched *actively decoding* block if we're
   * at capacity. Never evicts a 'verified' block (those are already cheap —
   * decoder freed) or the block about to be created. */
  private ensureCapacityForNewBlock(): void {
    const activeCount = Array.from(this.blocks.values()).filter((e) => e.status === 'receiving').length;
    if (activeCount < this.maxActiveBlockDecoders) return;

    for (const [blockIndex, entry] of this.blocks) {
      if (entry.status === 'receiving') {
        this.blocks.delete(blockIndex);
        return;
      }
    }
  }

  get state(): ReceiverSessionState {
    const manifestStatus: ManifestStatus = this.manifest ? 'valid' : 'missing';

    const blocks: BlockReceiveState[] = this.blockPlan
      ? Array.from({ length: this.blockPlan.blockCount }, (_, blockIndex) => this.blockState(blockIndex))
      : [];

    const status: SessionStatus = !this.manifest
      ? 'discovering'
      : blocks.every((b) => b.status === 'verified')
        ? 'completed'
        : 'receiving';

    return {
      transferId: this.transferId ? transferIdToHex(this.transferId) : '',
      manifestStatus,
      blocks,
      validFrames: this.validFrames,
      rejectedFrames: this.rejectedFrames,
      duplicateFrames: this.duplicateFrames,
      status,
    };
  }

  private blockState(blockIndex: number): BlockReceiveState {
    if (this.completedBlockBytes.has(blockIndex)) {
      const entry = this.blocks.get(blockIndex);
      return {
        blockIndex,
        sourceChunkCount: entry?.sourceChunkCount ?? 0,
        receivedDropletCount: entry?.receivedDropletCount ?? 0,
        uniqueDropletCount: entry?.seenSeeds.size ?? 0,
        solvedChunkCount: entry?.sourceChunkCount ?? 0,
        status: 'verified',
      };
    }
    const entry = this.blocks.get(blockIndex);
    if (!entry) return { blockIndex, sourceChunkCount: 0, receivedDropletCount: 0, uniqueDropletCount: 0, solvedChunkCount: 0, status: 'missing' };
    return {
      blockIndex,
      sourceChunkCount: entry.sourceChunkCount,
      receivedDropletCount: entry.receivedDropletCount,
      uniqueDropletCount: entry.seenSeeds.size,
      solvedChunkCount: entry.decoder?.recoveredCount ?? entry.sourceChunkCount,
      status: entry.status,
    };
  }

  /** The fully reconstructed transfer payload (still possibly compressed —
   * decompression is Milestone 8 / PR 7), once every block is verified.
   * `null` otherwise. */
  getAssembledData(): Uint8Array | null {
    if (!this.blockPlan || !this.manifest) return null;
    if (this.completedBlockBytes.size !== this.blockPlan.blockCount) return null;

    const out = new Uint8Array(this.manifest.encodedSize);
    for (let i = 0; i < this.blockPlan.blockCount; i++) {
      const range = this.blockPlan.getBlockRange(i);
      const bytes = this.completedBlockBytes.get(i);
      if (!bytes) return null; // defensive; size check above already guarantees this
      out.set(bytes, range.offset);
    }
    return out;
  }
}

function manifestsEqual(a: ManifestPayload, b: ManifestPayload): boolean {
  if (
    a.fileName !== b.fileName ||
    a.mimeType !== b.mimeType ||
    a.originalSize !== b.originalSize ||
    a.encodedSize !== b.encodedSize ||
    a.blockSize !== b.blockSize ||
    a.blockCount !== b.blockCount ||
    a.sourceChunkSize !== b.sourceChunkSize ||
    a.compression !== b.compression ||
    a.fileHashAlgorithm !== b.fileHashAlgorithm ||
    a.createdAt !== b.createdAt ||
    a.fileHash.length !== b.fileHash.length
  ) {
    return false;
  }
  for (let i = 0; i < a.fileHash.length; i++) {
    if (a.fileHash[i] !== b.fileHash[i]) return false;
  }
  return true;
}
