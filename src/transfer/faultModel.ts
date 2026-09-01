import { mulberry32 } from '../core/rng';

/**
 * A testable simulated optical channel (Milestone 16.3). Field names match
 * the roadmap's own sketch. `tileDropRate`/`burstLossLength` from that sketch
 * are Spark-Grid-tile concepts (Milestone 5) and aren't modeled here — this
 * operates purely at the frame level, which is all Protocol v2's session
 * layer (`SenderSession`/`ReceiverSession`) knows about.
 *
 * Deterministic: always pass a fixed `seed`. Never let a test depend on
 * real randomness — "Keine zufälligen Flaky Tests erzeugen. Seeds festlegen
 * und bei Fehlern ausgeben."
 */
export interface ChannelFaultModel {
  readonly frameDropRate: number;
  readonly frameDuplicateRate: number;
  readonly frameCorruptionRate: number;
  /** Frames are shuffled within non-overlapping windows of this size (0 = no
   * reordering). A true unbounded shuffle isn't representative of a real
   * optical channel, where frames arrive close to emission order. */
  readonly frameReorderWindow: number;
}

export const NO_FAULTS: ChannelFaultModel = {
  frameDropRate: 0,
  frameDuplicateRate: 0,
  frameCorruptionRate: 0,
  frameReorderWindow: 0,
};

/** Applies drop, duplicate, single-byte-flip corruption, and windowed
 * reordering to a sequence of frames, in that order, driven entirely by a
 * seeded PRNG so a failing test reproduces exactly from its printed seed. */
export function simulateChannel(frames: readonly Uint8Array[], faults: ChannelFaultModel, seed: number): Uint8Array[] {
  const rand = mulberry32(seed);
  const delivered: Uint8Array[] = [];

  for (const frame of frames) {
    if (rand() < faults.frameDropRate) continue;

    let outFrame = frame;
    if (faults.frameCorruptionRate > 0 && rand() < faults.frameCorruptionRate && outFrame.length > 0) {
      outFrame = outFrame.slice();
      const index = Math.floor(rand() * outFrame.length);
      outFrame[index] ^= 1 << Math.floor(rand() * 8);
    }

    delivered.push(outFrame);
    if (faults.frameDuplicateRate > 0 && rand() < faults.frameDuplicateRate) delivered.push(outFrame);
  }

  if (faults.frameReorderWindow > 0) {
    const window = faults.frameReorderWindow + 1;
    for (let start = 0; start < delivered.length; start += window) {
      const end = Math.min(start + window, delivered.length);
      // Fisher-Yates within [start, end).
      for (let i = end - 1; i > start; i--) {
        const j = start + Math.floor(rand() * (i - start + 1));
        [delivered[i], delivered[j]] = [delivered[j], delivered[i]];
      }
    }
  }

  return delivered;
}
