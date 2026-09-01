/**
 * Real, measured channel quality (Milestone 6.2). Field names match the
 * roadmap's own sketch verbatim. The roadmap is explicit that none of these
 * may be derived from an estimated display frame rate — every field here
 * comes from counting actual events (a frame captured, a marker/code
 * detected, a CRC that passed or failed) and actual elapsed wall-clock time,
 * never from `preset.fps` or any other nominal number.
 */
export interface ChannelQualityMetrics {
  readonly capturedFrames: number;
  /** A frame in which *something* was located (QR located, Grid markers
   * found) — whether or not it went on to decode validly. */
  readonly detectedFrames: number;
  readonly validFrames: number;
  readonly invalidFrames: number;
  readonly validTiles: number;
  readonly invalidTiles: number;
  /** 0..1, e.g. Grid's `detectGrid` quality score, averaged over the window. */
  readonly averageClassificationConfidence: number;
  /** Average time to process one captured frame, milliseconds. */
  readonly processingTimeMs: number;
  /** Real payload bytes (from valid frames only) per real elapsed second. */
  readonly effectivePayloadBytesPerSecond: number;
}

export interface QualityWindowOptions {
  /** Injectable for deterministic tests — defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Accumulates real capture/decode events over time and produces a
 * `ChannelQualityMetrics` snapshot. One instance covers one measurement
 * window — `reset()` (or constructing a new one) starts the next window;
 * `profileRecommender.ts` calls `snapshot()` once per window and feeds the
 * result in, then resets.
 */
export class QualityWindow {
  private readonly now: () => number;
  private readonly startedAt: number;

  private capturedFrames = 0;
  private detectedFrames = 0;
  private validFrames = 0;
  private invalidFrames = 0;
  private validTiles = 0;
  private invalidTiles = 0;
  private confidenceSum = 0;
  private confidenceCount = 0;
  private processingTimeSumMs = 0;
  private processingTimeCount = 0;
  private validPayloadBytes = 0;

  constructor(options: QualityWindowOptions = {}) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  recordCapturedFrame(): void {
    this.capturedFrames++;
  }

  recordDetectedFrame(): void {
    this.detectedFrames++;
  }

  /** `payloadBytes` is the useful bytes this frame actually carried (e.g. a
   * Data frame's fragment length) — not the frame's raw on-screen capacity. */
  recordValidFrame(payloadBytes: number, processingMs: number): void {
    this.validFrames++;
    this.validPayloadBytes += payloadBytes;
    this.recordProcessingTime(processingMs);
  }

  recordInvalidFrame(processingMs: number): void {
    this.invalidFrames++;
    this.recordProcessingTime(processingMs);
  }

  recordTile(valid: boolean): void {
    if (valid) this.validTiles++;
    else this.invalidTiles++;
  }

  /** `confidence` is expected in `0..1` (e.g. Grid's `detectGrid().quality`);
   * values outside that range are clamped rather than skewing the average. */
  recordClassificationConfidence(confidence: number): void {
    this.confidenceSum += Math.min(1, Math.max(0, confidence));
    this.confidenceCount++;
  }

  private recordProcessingTime(ms: number): void {
    this.processingTimeSumMs += Math.max(0, ms);
    this.processingTimeCount++;
  }

  snapshot(): ChannelQualityMetrics {
    const elapsedSeconds = Math.max(0.001, (this.now() - this.startedAt) / 1000);
    return {
      capturedFrames: this.capturedFrames,
      detectedFrames: this.detectedFrames,
      validFrames: this.validFrames,
      invalidFrames: this.invalidFrames,
      validTiles: this.validTiles,
      invalidTiles: this.invalidTiles,
      averageClassificationConfidence: this.confidenceCount === 0 ? 0 : this.confidenceSum / this.confidenceCount,
      processingTimeMs: this.processingTimeCount === 0 ? 0 : this.processingTimeSumMs / this.processingTimeCount,
      effectivePayloadBytesPerSecond: this.validPayloadBytes / elapsedSeconds,
    };
  }
}
