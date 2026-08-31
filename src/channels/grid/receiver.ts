import { decodeGridCells } from './codec';
import { detectGrid, guideBoxFor, type Detection } from './detect';
import { specFor, GRID_PRESETS, type GridPreset, type GridSpec } from './spec';
import type { CameraFrame, ChannelReceiver } from '../types';

/** After this long without a readable frame, assume the sender changed and re-acquire. */
const LOCK_TIMEOUT_MS = 4000;

export class GridReceiver implements ChannelReceiver {
  readonly channel = 'grid' as const;
  /** Turbo cells are only a few pixels wide; anything less than this smears them together. */
  readonly preferredWidth = 1280;

  private readonly candidates: { preset: GridPreset; spec: GridSpec }[] = GRID_PRESETS.map((preset) => ({
    preset,
    spec: specFor(preset),
  }));

  /**
   * Which density the sender is using. Unknown at first, so every preset is tried
   * until one produces a CRC-valid frame — the checksum identifies the right one, so
   * the user never has to match a setting to the other device by hand. Trying the
   * wrong preset is cheap: its markers sit at a different inset and size, so marker
   * detection usually bails before any cell sampling happens.
   */
  private locked: { preset: GridPreset; spec: GridSpec } | null = null;

  private goodFrames = 0;
  private attempts = 0;
  private lastQuality = 0;
  private lastReason: Detection['reason'] = 'no-markers';
  private lastHit = 0;

  constructor(private readonly onPacket: (bytes: Uint8Array) => void) {}

  get status(): string {
    if (this.goodFrames > 0 && Date.now() - this.lastHit < 1500) {
      return `Empfang läuft · ${this.locked?.preset.label ?? ''} · ${this.goodFrames} Frames`;
    }
    if (this.lastReason === 'no-markers') return 'Raster im Rahmen ausrichten – suche die vier Ecken';
    if (this.lastReason === 'washed-out') return 'Farben zu ähnlich – näher ran oder Bildschirm heller stellen';
    if (this.goodFrames === 0) return 'Ecken erkannt – halte still, lese Farben …';
    return 'Signal verloren – neu ausrichten';
  }

  /** Density recognised from the beam, once one frame has passed its checksum. */
  get detectedPreset(): string | null {
    return this.locked?.preset.label ?? null;
  }

  /** Share of frames that survived the CRC — the honest measure of alignment. */
  get hitRate(): number {
    return this.attempts === 0 ? 0 : this.goodFrames / this.attempts;
  }

  get quality(): number {
    return this.lastQuality;
  }

  async ingest(frame: CameraFrame): Promise<void> {
    this.attempts++;
    const guide = guideBoxFor(frame.width, frame.height);

    for (const candidate of this.locked ? [this.locked] : this.candidates) {
      const detection = detectGrid(frame.imageData, candidate.spec, guide);
      this.lastQuality = detection.quality;
      this.lastReason = detection.reason;
      if (!detection.cells) continue;

      const body = decodeGridCells(detection.cells, candidate.spec);
      if (!body) continue; // CRC rejected it; the next frame costs us nothing

      this.locked = candidate;
      this.goodFrames++;
      this.lastHit = Date.now();
      this.onPacket(body);
      return;
    }

    if (this.locked && Date.now() - this.lastHit > LOCK_TIMEOUT_MS) this.locked = null;
  }
}
