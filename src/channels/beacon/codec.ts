import { crc8 } from '../../core/crc32';

/**
 * Blitz-Beacon: the whole screen flashes one flat colour at a time.
 *
 * The trick that makes this work without any clock recovery is *differential*
 * coding: a symbol is not the colour itself but the step from the previous colour,
 *
 *     colour[i] = (colour[i-1] + 1 + value) mod 8,   value in 0..3
 *
 * Since the step is never 0, two neighbouring symbols can never share a colour.
 * So every symbol boundary is a visible colour change, and the receiver just has
 * to notice changes instead of locking onto a clock. Steps 1..4 carry two bits;
 * step 5 is a frame delimiter that data can never counterfeit; 6 and 7 are spare.
 */

export const BEACON_PALETTE = [
  '#000000', // 0 black
  '#ff0000', // 1 red
  '#ffff00', // 2 yellow
  '#00ff00', // 3 green
  '#00ffff', // 4 cyan
  '#0000ff', // 5 blue
  '#ff00ff', // 6 magenta
  '#ffffff', // 7 white
] as const;

export const DELIMITER_STEP = 5;
export const MAX_BEACON_BYTES = 255;

/**
 * The step sequence for one message, delimiter first.
 *
 * Steps rather than colours, because the sender loops forever: it keeps a running
 * colour across passes and just keeps applying steps. Emitting a fixed colour array
 * instead would leave an arbitrary step at each loop seam, which could be read as a
 * spurious delimiter — or as no transition at all — once per pass.
 */
export function encodeBeaconFrame(payload: Uint8Array): number[] {
  if (payload.length > MAX_BEACON_BYTES) throw new Error('Beacon-Nachricht zu lang');

  const steps: number[] = [DELIMITER_STEP];
  const pushByte = (byte: number) => {
    for (let shift = 6; shift >= 0; shift -= 2) steps.push(((byte >> shift) & 0b11) + 1);
  };

  pushByte(payload.length);
  for (const byte of payload) pushByte(byte);
  pushByte(crc8(payload));
  return steps;
}

/** Walks a step sequence into displayed colours — used by the sender and by tests. */
export function stepsToColours(steps: number[], passes = 1, startColour = 0): number[] {
  const colours: number[] = [startColour];
  let colour = startColour;
  for (let pass = 0; pass < passes; pass++) {
    for (const step of steps) {
      colour = (colour + step) % 8;
      colours.push(colour);
    }
  }
  return colours;
}

type State = 'sync' | 'length' | 'data' | 'crc';

/**
 * Feed observed colour indices (already de-duplicated: one push per visible change).
 * Returns the payload the moment a frame arrives with a matching CRC.
 */
export class BeaconStreamDecoder {
  private previous: number | null = null;
  private state: State = 'sync';
  private partial: number[] = [];
  private bytes: number[] = [];
  private expectedLength = 0;

  /** Steps seen since the last delimiter — lets the UI show that *something* is arriving. */
  symbolsSeen = 0;

  push(colour: number): Uint8Array | null {
    const previous = this.previous;
    this.previous = colour;
    if (previous === null) return null;

    const step = (colour - previous + 8) % 8;
    if (step === 0) return null; // not a real transition
    this.symbolsSeen++;

    if (step === DELIMITER_STEP) {
      this.startFrame();
      return null;
    }
    if (step > DELIMITER_STEP || this.state === 'sync') {
      // 6 and 7 are unused, so seeing one means we misread something.
      this.state = 'sync';
      return null;
    }

    this.partial.push(step - 1);
    if (this.partial.length < 4) return null;

    let byte = 0;
    for (const value of this.partial) byte = (byte << 2) | value;
    this.partial = [];
    return this.acceptByte(byte);
  }

  private startFrame(): void {
    this.state = 'length';
    this.partial = [];
    this.bytes = [];
  }

  private acceptByte(byte: number): Uint8Array | null {
    switch (this.state) {
      case 'length':
        this.expectedLength = byte;
        this.state = byte === 0 ? 'crc' : 'data';
        return null;

      case 'data':
        this.bytes.push(byte);
        if (this.bytes.length >= this.expectedLength) this.state = 'crc';
        return null;

      case 'crc': {
        const payload = new Uint8Array(this.bytes);
        this.state = 'sync';
        return crc8(payload) === byte ? payload : null;
      }

      default:
        return null;
    }
  }

  reset(): void {
    this.previous = null;
    this.state = 'sync';
    this.partial = [];
    this.bytes = [];
    this.symbolsSeen = 0;
  }

  get progressHint(): string {
    switch (this.state) {
      case 'sync':
        return 'Warte auf Signalanfang …';
      case 'length':
        return 'Signal erkannt – lese Länge';
      case 'data':
        return `Empfange … ${this.bytes.length}/${this.expectedLength} Bytes`;
      case 'crc':
        return 'Prüfsumme …';
    }
  }
}

/**
 * Classifies one averaged camera colour into a palette index.
 *
 * Normalising by the brightest channel throws away exposure and most of the white
 * balance, leaving "which channels are lit" — the RGB-cube corner. `reference` is a
 * running maximum brightness so that "black" means dark *relative to this transfer*
 * rather than dark in absolute terms.
 */
export function classifyBeaconColour(
  r: number,
  g: number,
  b: number,
  reference: number,
): { index: number; confident: boolean } {
  const max = Math.max(r, g, b);
  if (max < Math.max(28, reference * 0.34)) return { index: 0, confident: max < reference * 0.24 };

  const cut = max * 0.55;
  const hi = (channel: number) => (channel > cut ? 1 : 0);
  const pattern = (hi(r) << 2) | (hi(g) << 1) | hi(b);

  // Values sit far from the 0.55 cut when the colour is clean; if any channel lands
  // near it, the frame is probably a mid-transition blend and should not be trusted.
  const ambiguous = [r, g, b].some((channel) => Math.abs(channel - cut) < max * 0.14);

  const index = {
    0b100: 1, // red
    0b110: 2, // yellow
    0b010: 3, // green
    0b011: 4, // cyan
    0b001: 5, // blue
    0b101: 6, // magenta
    0b111: 7, // white
  }[pattern];

  if (index === undefined) return { index: 0, confident: false };
  return { index, confident: !ambiguous };
}
