import { FountainDecoder } from '../core/fountain';
import { crc32 } from '../core/crc32';
import { decodeBlockComplete } from '../protocol/blockComplete';
import { decodeCommonFrameHeader, decodeDataFrameHeader } from '../protocol/frameHeader';
import { decodeManifest } from '../protocol/manifest';
import { transferIdsEqual, transferIdToHex } from '../protocol/transferId';
import { DATA_HEADER_SIZE, FrameType, type ManifestPayload, type TransferManifest } from '../protocol/types';
import { createBlockPlanFromManifest, type BlockPlan } from './blockPlan';
import { StorageUnavailableError, type PersistedReceiveState, type TransferRepository } from '../storage/types';

/** Milestone 2.4: only this many blocks may have a live `FountainDecoder`
 * (i.e. be `'receiving'`) at once. A block beyond this bound is evicted —
 * its partial progress is discarded, not persisted; it simply restarts from
 * scratch if drops for it arrive again later, which they will, since the
 * sender repeats every block cyclically with no back-channel to tell it to
 * stop. (Persistence, added in PR 3, only ever stores *verified* blocks —
 * see Milestone 4.2 — so a discarded in-progress decoder was never
 * persistable in the first place.) */
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
  /** Diagnostic message, set on either a manifest conflict (Milestone 4.4)
   * or a storage error (Milestone 4.5) — human-readable, safe to show
   * directly in a diagnostics view, never includes payload bytes. **Not**
   * the same thing as `status === 'failed'`: a conflict both sets this
   * *and* forces `status` to `'failed'` (the transfer genuinely cannot
   * proceed), but a storage hiccup only sets this — receiving continues
   * normally in memory, only persistence (and therefore a future resume)
   * is affected. Once set, stays set for the rest of the session. */
  readonly failureReason: string | null;
  /** True once this transfer was recognised, on its first manifest, as
   * matching a previously *partially* received one in storage — i.e. this
   * is a resume, not a fresh transfer (Milestone 4.3). */
  readonly resumed: boolean;
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
   * ever seen" set (Milestone 2.4's "keine unbegrenzten Sets" rule). */
  seenSeeds: Set<number>;
  receivedDropletCount: number;
  status: BlockStatus;
}

function manifestPayloadOf(manifest: TransferManifest): ManifestPayload {
  const { transferId: _transferId, protocolVersion: _protocolVersion, ...payload } = manifest;
  return payload;
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

export interface ReceiverSessionOptions {
  readonly maxActiveBlockDecoders?: number;
  /** When provided: verified blocks are persisted as they complete, and a
   * matching manifest for a transfer already partially in storage triggers
   * Resume — already-verified blocks are loaded back rather than
   * re-decoded (Milestone 4.3). Omit for the PR 2 behaviour (in-memory
   * only, nothing survives this `ReceiverSession` instance). */
  readonly repository?: TransferRepository;
}

/**
 * Consumes raw Protocol v2 frame bytes (as produced by `SenderSession`, or —
 * once a later PR wires this into a real channel — decoded off a QR/Grid
 * stream) and reconstructs the transfer, one independently-verified block at
 * a time. No DOM dependencies beyond whatever `TransferRepository`
 * implementation is injected (the interface itself has none): works from a
 * Web Worker or a Node test alike.
 *
 * `ingestFrame` calls must be awaited one at a time, in order — this class
 * does no internal queuing. That matches how it's actually driven elsewhere
 * in this codebase (`ui/useCamera.ts`'s capture loop already serialises
 * `ChannelReceiver.ingest` calls with a `busy` flag); a future channel
 * adapter wiring this in for real should do the same.
 *
 * Deliberately out of scope here (see docs/architecture-audit.md's PR 3
 * plan): no file-level SHA-256 verification (Milestone 8 / PR 7 —
 * `manifest.fileHash` is carried through but not yet checked), no
 * unresolved-droplet or decoder-state persistence (Milestone 4.2 explicitly
 * scopes the first version down to verified blocks only), no conflict *UI*
 * (this class detects and reports a conflict via `state.failureReason`; a
 * later PR is responsible for showing it to a user).
 */
export class ReceiverSession {
  private readonly maxActiveBlockDecoders: number;
  private readonly repository: TransferRepository | undefined;

  private transferId: Uint8Array | null = null;
  private manifest: ManifestPayload | null = null;
  private blockPlan: BlockPlan | null = null;
  /** Diagnostic only — set on *either* a conflict or a storage hiccup.
   * Whether that also forces `status` to `'failed'` is `conflict`, below;
   * a storage error alone must not stop an otherwise-healthy in-memory
   * transfer (Milestone 4.5: reported clearly, never fatal to receiving). */
  private failureReason: string | null = null;
  /** Milestone 4.4: a differing manifest for a transferId already in
   * storage. Unlike a storage hiccup, this genuinely stops the transfer —
   * there is no safe way to guess which manifest is right. */
  private conflict = false;
  private resumed = false;

  private readonly blocks = new Map<number, BlockEntry>();
  private readonly completedBlockBytes = new Map<number, Uint8Array>();
  /** blockIndex -> sender-announced CRC-32, from BlockComplete frames.
   * Bounded by blockCount (itself capped at MAX_BLOCK_COUNT), since a Map
   * keyed by blockIndex can never hold more than blockCount entries. */
  private readonly announcedBlockCrc = new Map<number, number>();

  private validFrames = 0;
  private rejectedFrames = 0;
  private duplicateFrames = 0;

  constructor(options: ReceiverSessionOptions = {}) {
    this.maxActiveBlockDecoders = options.maxActiveBlockDecoders ?? DEFAULT_MAX_ACTIVE_BLOCK_DECODERS;
    this.repository = options.repository;
  }

  async ingestFrame(bytes: Uint8Array): Promise<void> {
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
        await this.ingestManifest(header.transferId, payload);
        return;
      case FrameType.Data:
        await this.ingestData(payload);
        return;
      case FrameType.BlockComplete:
        await this.ingestBlockComplete(payload);
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

  private async ingestManifest(transferId: Uint8Array, payload: Uint8Array): Promise<void> {
    const manifest = decodeManifest(payload);
    if (!manifest) {
      this.rejectedFrames++;
      return;
    }

    if (this.manifest) {
      // Same transferId, manifest already known this session — either an
      // identical cyclic resend (expected, common) or a genuine conflict.
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

    if (this.repository) {
      const hex = transferIdToHex(transferId);
      let stored: TransferManifest | null;
      try {
        stored = await this.repository.loadManifest(hex);
      } catch (cause) {
        this.recordStorageFailure(cause);
        stored = null; // fall through and treat as a fresh transfer — storage being unavailable must not block receiving
      }

      if (stored && !manifestsEqual(manifestPayloadOf(stored), manifest)) {
        // Milestone 4.4: a different manifest for a transferId we already
        // have data for. Stop and report, never silently apply the new one
        // over — or interleave it with — whatever's already stored.
        this.conflict = true;
        this.failureReason = `Conflicting manifest for transfer ${hex}: stored data does not match the newly received manifest. Refusing to overwrite.`;
        this.rejectedFrames++;
        return;
      }

      this.transferId = transferId;
      this.manifest = manifest;
      this.blockPlan = plan;
      this.validFrames++;

      if (stored) {
        this.resumed = true;
        await this.loadVerifiedBlocksFromStorage(hex, plan);
      } else {
        try {
          await this.repository.saveManifest({ ...manifest, transferId, protocolVersion: 2 });
        } catch (cause) {
          this.recordStorageFailure(cause);
        }
      }
      return;
    }

    this.transferId = transferId;
    this.manifest = manifest;
    this.blockPlan = plan;
    this.validFrames++;
  }

  /** Resume (Milestone 4.3): load every already-verified block straight
   * from storage, skipping Fountain decode entirely for each one — only
   * blocks *not* in `verifiedBlockIndices` are left for the Fountain layer
   * to receive normally. */
  private async loadVerifiedBlocksFromStorage(transferIdHex: string, plan: BlockPlan): Promise<void> {
    if (!this.repository) return;
    let receiveState: PersistedReceiveState | null;
    try {
      receiveState = await this.repository.loadReceiveState(transferIdHex);
    } catch (cause) {
      this.recordStorageFailure(cause);
      return;
    }
    if (!receiveState) return;

    for (const blockIndex of receiveState.verifiedBlockIndices) {
      if (blockIndex < 0 || blockIndex >= plan.blockCount) continue; // defensive; stored data is still not blindly trusted
      if (this.completedBlockBytes.has(blockIndex)) continue;
      try {
        const data = await this.repository.loadBlock(transferIdHex, blockIndex);
        if (data && data.length === plan.getBlockRange(blockIndex).length) {
          this.completedBlockBytes.set(blockIndex, data);
        }
        // A missing or wrong-length block despite being listed as verified
        // is treated the same as never having stored it — it simply gets
        // received again, rather than failing the whole resume.
      } catch (cause) {
        this.recordStorageFailure(cause);
      }
    }
  }

  private async ingestData(payload: Uint8Array): Promise<void> {
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
      await this.tryFinalizeBlock(dataHeader.blockIndex, entry);
    }
  }

  private async ingestBlockComplete(payload: Uint8Array): Promise<void> {
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
    if (entry?.decoder?.isComplete) await this.tryFinalizeBlock(parsed.blockIndex, entry);
  }

  private async tryFinalizeBlock(blockIndex: number, entry: BlockEntry): Promise<void> {
    const announcedCrc = this.announcedBlockCrc.get(blockIndex);
    if (announcedCrc === undefined) return; // decoded, but no CRC to check against yet — stays 'decoded'

    const data = entry.decoder!.getData();
    if (!data) return; // defensive; isComplete already guarantees this is non-null

    if (crc32(data) === announcedCrc) {
      entry.status = 'verified';
      entry.decoder = null; // free the equation-graph memory; only the small entry + final bytes remain
      this.completedBlockBytes.set(blockIndex, data);
      this.blocks.delete(blockIndex);
      await this.persistVerifiedBlock(blockIndex, data);
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

  private async persistVerifiedBlock(blockIndex: number, data: Uint8Array): Promise<void> {
    if (!this.repository || !this.transferId || !this.blockPlan) return;
    const hex = transferIdToHex(this.transferId);
    try {
      await this.repository.saveBlock(hex, blockIndex, data);
      const verifiedBlockIndices = Array.from(this.completedBlockBytes.keys()).sort((a, b) => a - b);
      let receivedBytes = 0;
      for (const i of verifiedBlockIndices) receivedBytes += this.blockPlan.getBlockRange(i).length;
      const state: PersistedReceiveState = {
        transferId: hex,
        protocolVersion: 2,
        verifiedBlockIndices,
        totalBytes: this.manifest!.encodedSize,
        receivedBytes,
        lastUpdatedAt: Date.now(),
      };
      await this.repository.saveReceiveState(state);
    } catch (cause) {
      // A block that failed to persist is still verified *in this running
      // session* — receiving continues normally. What's lost is only the
      // ability to resume this specific block after a reload, which is
      // exactly the "Speicherfehler führen zu einer verständlichen
      // Fehlermeldung", not "Speicherfehler bricht den Empfang ab".
      this.recordStorageFailure(cause);
    }
  }

  private recordStorageFailure(cause: unknown): void {
    const message = cause instanceof StorageUnavailableError ? cause.message : 'Unknown storage error';
    this.failureReason = `Storage error: ${message}`;
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

    const status: SessionStatus = this.conflict
      ? 'failed'
      : !this.manifest
        ? 'discovering'
        : blocks.length > 0 && blocks.every((b) => b.status === 'verified')
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
      failureReason: this.failureReason,
      resumed: this.resumed,
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
   * `null` otherwise. Synchronous and storage-free: resume already loaded
   * every verified block into memory when the manifest was ingested. */
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
