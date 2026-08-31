import { BEACON_PALETTE, encodeBeaconFrame } from './codec';
import type { BeamSource } from '../types';

export interface BeaconPreset {
  id: 'safe' | 'normal' | 'fast';
  label: string;
  hint: string;
  fps: number;
}

export const BEACON_PRESETS: BeaconPreset[] = [
  { id: 'safe', label: 'Sicher', hint: '5 Symbole/s – auch bei wackliger Kamera', fps: 5 },
  { id: 'normal', label: 'Normal', hint: '8 Symbole/s', fps: 8 },
  { id: 'fast', label: 'Schnell', hint: '10 Symbole/s – braucht eine Kamera mit 30 fps oder mehr', fps: 10 },
];

export class BeaconBeamSource implements BeamSource {
  readonly channel = 'beacon' as const;
  readonly fps: number;
  readonly bytesPerFrame = 0.25;
  readonly chunkCount = null;

  private readonly steps: number[];
  private index = 0;
  private sent = 0;
  /** Carried across loop passes so every seam is still a well-formed step. */
  private colour = 0;

  constructor(payload: Uint8Array, preset: BeaconPreset) {
    this.steps = encodeBeaconFrame(payload);
    this.fps = preset.fps;
  }

  get framesSent(): number {
    return this.sent;
  }

  /** One full pass through the message. */
  get estimatedSeconds(): number {
    return this.steps.length / this.fps;
  }

  get symbolCount(): number {
    return this.steps.length;
  }

  /** 0..1 through the current loop — the beacon repeats, so this is a cycle, not a total. */
  get cycleProgress(): number {
    return this.steps.length === 0 ? 0 : (this.index % this.steps.length) / this.steps.length;
  }

  renderFrame(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    // Show the current colour, then step. Stepping first would swallow the starting
    // colour, and with it the opening delimiter transition — the receiver would have
    // to wait for the loop seam a whole pass later before it could sync.
    const colour = this.colour;
    this.colour = (this.colour + this.steps[this.index % this.steps.length]) % 8;
    this.index++;
    this.sent++;

    // A fixed neutral border gives the camera's auto-exposure something steady to
    // hold on to, so a run of dark symbols doesn't make it hunt.
    ctx.fillStyle = '#6b6b6b';
    ctx.fillRect(0, 0, width, height);

    const inset = Math.round(Math.min(width, height) * 0.11);
    ctx.fillStyle = BEACON_PALETTE[colour];
    ctx.fillRect(inset, inset, width - inset * 2, height - inset * 2);
  }
}
