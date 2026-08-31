import { BeaconStreamDecoder, classifyBeaconColour } from './codec';
import type { CameraFrame, ChannelReceiver } from '../types';

/**
 * Sampling faster than this per second means we can afford to demand two consecutive
 * frames of a colour, which throws away single-frame blends caught mid-switch. Below
 * it there are too few samples per symbol to spend one that way: missing a symbol is
 * worse than admitting a blip, because a skipped symbol turns two real steps into one
 * bogus one — which can even masquerade as the frame delimiter.
 */
const DEBOUNCE_SAMPLE_RATE = 20;

export class BeaconReceiver implements ChannelReceiver {
  readonly channel = 'beacon' as const;
  /** Only a centre average is needed, so keep it tiny and leave headroom for frame rate. */
  readonly preferredWidth = 320;

  private readonly stream = new BeaconStreamDecoder();
  private candidate: number | null = null;
  private candidateAge = 0;
  private accepted: number | null = null;
  private brightnessReference = 60;
  private lastColour = 0;

  private lastSampleAt = 0;
  /** Smoothed interval between frames, so the debounce follows the real sample rate. */
  private sampleInterval = 1000 / 60;

  constructor(private readonly onMessage: (text: string) => void) {}

  get status(): string {
    return this.stream.progressHint;
  }

  /** How many identical frames a colour needs before it counts as a new symbol. */
  private get stableFrames(): number {
    return 1000 / this.sampleInterval >= DEBOUNCE_SAMPLE_RATE ? 2 : 1;
  }

  /** Drives the little "this is what I see" swatch in the UI. */
  get observedColour(): number {
    return this.lastColour;
  }

  async ingest(frame: CameraFrame): Promise<void> {
    const now = performance.now();
    if (this.lastSampleAt > 0) {
      const gap = Math.min(500, now - this.lastSampleAt);
      this.sampleInterval = this.sampleInterval * 0.9 + gap * 0.1;
    }
    this.lastSampleAt = now;

    const { r, g, b } = averageCentre(frame);

    // Track the brightest thing seen lately, decaying slowly, as the yardstick for
    // "dark". Without it, a dim room and a bright room disagree about black.
    this.brightnessReference = Math.max(this.brightnessReference * 0.995, Math.max(r, g, b));

    const { index, confident } = classifyBeaconColour(r, g, b, this.brightnessReference);
    this.lastColour = index;
    if (!confident) {
      this.candidateAge = 0;
      return;
    }

    if (index !== this.candidate) {
      this.candidate = index;
      this.candidateAge = 1;
    } else {
      this.candidateAge++;
    }

    if (this.candidateAge !== this.stableFrames) return; // fire once per stable run
    if (index === this.accepted) return;

    this.accepted = index;
    const payload = this.stream.push(index);
    if (payload) this.onMessage(new TextDecoder().decode(payload));
  }

  reset(): void {
    this.stream.reset();
    this.candidate = null;
    this.accepted = null;
    this.candidateAge = 0;
  }
}

/** Mean colour of the middle of the frame, where the beacon's colour field sits. */
function averageCentre(frame: CameraFrame): { r: number; g: number; b: number } {
  const { imageData, width, height } = frame;
  const x0 = Math.floor(width * 0.3);
  const x1 = Math.floor(width * 0.7);
  const y0 = Math.floor(height * 0.3);
  const y1 = Math.floor(height * 0.7);

  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const step = 2; // every other pixel is plenty for an average
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * width + x) * 4;
      r += imageData.data[i];
      g += imageData.data[i + 1];
      b += imageData.data[i + 2];
      n++;
    }
  }
  return n === 0 ? { r: 0, g: 0, b: 0 } : { r: r / n, g: g / n, b: b / n };
}
