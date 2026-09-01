import { FountainEncoder, pickIndices } from '../core/fountain';
import { crc32 } from '../core/crc32';
import { encodeBlockComplete } from '../protocol/blockComplete';
import { encodeCommonFrameHeader, encodeDataFrameHeader, isSystematic } from '../protocol/frameHeader';
import { encodeManifest } from '../protocol/manifest';
import { FLAG_SYSTEMATIC, FrameType, PROTOCOL_VERSION, type ManifestPayload } from '../protocol/types';
import { createBlockPlan, type BlockPlan } from './blockPlan';

export interface SenderSessionOptions {
  readonly transferId: Uint8Array;
  /** Everything except `transferId`/`protocolVersion` — those are supplied
   * by the session itself on every frame (see docs/protocol-v2.md §4). */
  readonly manifest: ManifestPayload;
  /** The full transfer payload — already compressed if `manifest.compression`
   * says so (compression itself is Milestone 8 / PR 7, out of scope here).
   * Must be exactly `manifest.encodedSize` bytes. */
  readonly data: Uint8Array;
  /** How many Data/BlockComplete frames between each Manifest re-send.
   * Lower = a joining receiver discovers the transfer faster, at the cost of
   * displaced payload frames. */
  readonly manifestEveryNFrames?: number;
  /** How many Data frames between each BlockComplete re-send for the
   * currently active block. */
  readonly blockCompleteEveryNFrames?: number;
  /** Extra drops sent for a block, as a multiple of its source chunk count,
   * before rotating to the next block (Milestone 2.2's "nach konfigurierbarem
   * Overhead"). 1.0 would be exactly the systematic pass with no fountain
   * drops at all; something above 1 leaves room for a receiver who joined
   * partway through, or lost a few frames, to still complete the block
   * before the sender moves on (it comes back around — see below). */
  readonly overheadFactor?: number;
}

const DEFAULT_MANIFEST_EVERY_N_FRAMES = 20;
const DEFAULT_BLOCK_COMPLETE_EVERY_N_FRAMES = 10;
const DEFAULT_OVERHEAD_FACTOR = 1.5;

/**
 * Produces an endless stream of raw Protocol v2 wire frames for one
 * transfer — channel-agnostic (returns `Uint8Array`s, not canvas draw
 * calls): a QR/Grid channel adapter is responsible for actually displaying
 * these bytes (base45+QR, or the Spark Grid codec). That wiring doesn't
 * exist yet (PR 3+) — this class is fully usable and tested standalone.
 *
 * Cycles blocks forever (Milestone 2.2's "Ohne Rückkanal müssen Blöcke
 * zyklisch erneut gesendet werden können") — there is no feedback channel
 * in PR 2, so the sender has no way to know when to stop covering a block it
 * already finished sending once.
 */
export class SenderSession {
  readonly manifest: ManifestPayload;
  readonly blockPlan: BlockPlan;

  private readonly transferId: Uint8Array;
  private readonly data: Uint8Array;
  private readonly manifestEveryNFrames: number;
  private readonly blockCompleteEveryNFrames: number;
  private readonly overheadFactor: number;
  /** Precomputed once, not per repeat — CRC-32 over each block's true bytes,
   * which the sender already holds in full. Synchronous, O(encodedSize)
   * work at construction; fine at the sizes exercised so far, a candidate
   * for a Worker (Milestone 9) if a future large-file benchmark says so. */
  private readonly blockCrc: readonly number[];

  private sequenceNumber = 0;
  private framesSinceManifest = 0;
  private framesSinceBlockComplete = 0;
  private activeBlockIndex = 0;
  private activeEncoder!: FountainEncoder;
  private dropsForActiveBlock = 0;

  constructor(options: SenderSessionOptions) {
    if (options.data.length !== options.manifest.encodedSize) {
      throw new Error(`data length ${options.data.length} does not match manifest.encodedSize ${options.manifest.encodedSize}`);
    }

    this.transferId = options.transferId;
    this.manifest = options.manifest;
    this.data = options.data;
    this.manifestEveryNFrames = options.manifestEveryNFrames ?? DEFAULT_MANIFEST_EVERY_N_FRAMES;
    this.blockCompleteEveryNFrames = options.blockCompleteEveryNFrames ?? DEFAULT_BLOCK_COMPLETE_EVERY_N_FRAMES;
    this.overheadFactor = options.overheadFactor ?? DEFAULT_OVERHEAD_FACTOR;

    this.blockPlan = createBlockPlan(this.manifest.encodedSize, this.manifest.blockSize);
    if (this.blockPlan.blockCount !== this.manifest.blockCount) {
      throw new Error(`manifest.blockCount ${this.manifest.blockCount} disagrees with the computed plan (${this.blockPlan.blockCount})`);
    }

    const crcs: number[] = [];
    for (let i = 0; i < this.blockPlan.blockCount; i++) {
      const range = this.blockPlan.getBlockRange(i);
      crcs.push(crc32(this.data.subarray(range.offset, range.offset + range.length)));
    }
    this.blockCrc = crcs;

    // The very first frame emitted is always the manifest, not merely "some
    // frame within the first manifestEveryNFrames" — a receiver with no
    // manifest yet can't do anything useful with a Data frame at all, so the
    // discovery-critical frame goes out immediately rather than waiting a
    // full cadence period.
    this.framesSinceManifest = this.manifestEveryNFrames;

    this.startBlock(0);
  }

  /** One more raw v2 frame — Manifest, Data, or BlockComplete, in a
   * repeating cadence (see the `*EveryNFrames` options). */
  next(): Uint8Array {
    this.sequenceNumber = (this.sequenceNumber + 1) >>> 0;

    if (this.framesSinceManifest >= this.manifestEveryNFrames) {
      this.framesSinceManifest = 0;
      return this.buildManifestFrame();
    }
    this.framesSinceManifest++;

    if (this.framesSinceBlockComplete >= this.blockCompleteEveryNFrames) {
      this.framesSinceBlockComplete = 0;
      return this.buildBlockCompleteFrame();
    }
    this.framesSinceBlockComplete++;

    return this.buildDataFrame();
  }

  private startBlock(blockIndex: number): void {
    const range = this.blockPlan.getBlockRange(blockIndex);
    const blockBytes = this.data.subarray(range.offset, range.offset + range.length);
    this.activeBlockIndex = blockIndex;
    this.activeEncoder = new FountainEncoder(blockBytes, this.manifest.sourceChunkSize);
    this.dropsForActiveBlock = 0;
  }

  private buildDataFrame(): Uint8Array {
    const { seed, payload } = this.activeEncoder.next();
    this.dropsForActiveBlock++;

    const blockSourceChunkCount = this.activeEncoder.chunkCount;
    // Recomputed rather than returned by FountainEncoder.next(), which
    // doesn't expose degree directly — pickIndices is a pure, cheap,
    // deterministic function, and core/fountain.ts is deliberately not
    // modified by this PR (reuse, not rewrite — see ADR 0001).
    const degree = pickIndices(seed, blockSourceChunkCount).length;
    const systematic = isSystematic(seed, blockSourceChunkCount);

    const dataHeader = encodeDataFrameHeader({
      blockIndex: this.activeBlockIndex,
      blockSourceChunkCount,
      dropletSeed: seed,
      dropletDegree: degree,
    });

    const framePayload = new Uint8Array(dataHeader.length + payload.length);
    framePayload.set(dataHeader, 0);
    framePayload.set(payload, dataHeader.length);

    const frame = this.wrapFrame(FrameType.Data, systematic ? FLAG_SYSTEMATIC : 0, framePayload);

    this.maybeRotateBlock(blockSourceChunkCount);
    return frame;
  }

  private maybeRotateBlock(blockSourceChunkCount: number): void {
    const threshold = Math.ceil(blockSourceChunkCount * this.overheadFactor);
    if (this.dropsForActiveBlock < threshold) return;
    const nextBlockIndex = (this.activeBlockIndex + 1) % this.blockPlan.blockCount;
    this.startBlock(nextBlockIndex);
  }

  private buildManifestFrame(): Uint8Array {
    return this.wrapFrame(FrameType.Manifest, 0, encodeManifest(this.manifest));
  }

  private buildBlockCompleteFrame(): Uint8Array {
    const payload = encodeBlockComplete({ blockIndex: this.activeBlockIndex, blockCrc32: this.blockCrc[this.activeBlockIndex] });
    return this.wrapFrame(FrameType.BlockComplete, 0, payload);
  }

  private wrapFrame(frameType: FrameType, flags: number, payload: Uint8Array): Uint8Array {
    const header = encodeCommonFrameHeader({
      protocolVersion: PROTOCOL_VERSION,
      frameType,
      flags,
      transferId: this.transferId,
      sequenceNumber: this.sequenceNumber,
      payloadLength: payload.length,
    });
    const frame = new Uint8Array(header.length + payload.length);
    frame.set(header, 0);
    frame.set(payload, header.length);
    return frame;
  }
}
