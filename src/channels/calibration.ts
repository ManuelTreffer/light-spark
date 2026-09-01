import type { ChannelProfile } from './profile';
import type { ChannelQualityMetrics } from './qualityMetrics';

/**
 * Calibration scoring (Milestone 6.4) — the measurable half only. The
 * roadmap's full calibration workflow ("mehrere bekannte Frames anzeigen,
 * verschiedene Grid-Dichten testen, ... Ergebnis anzeigen, Nutzer darf
 * Profil überschreiben") is an interactive sender↔receiver handshake: the
 * sender needs to know which profile the receiver is currently scoring so
 * it can show the *matching* test pattern, and today there is no feedback
 * channel to coordinate that (Milestone 10, not yet built) and no
 * fixed/pre-agreed timing schedule either. Building a bespoke
 * synchronization scheme just for calibration, ahead of the real feedback
 * channel, risked being thrown away once Milestone 10 lands — so this file
 * implements only the scoring/selection step, reusable as-is once
 * something else (a future calibration UI, driven by a fixed schedule or a
 * real feedback channel) supplies the actual (profile, measured metrics)
 * pairs.
 */

export interface ProfileCandidate {
  readonly profile: ChannelProfile;
  readonly metrics: ChannelQualityMetrics;
}

export interface SelectBestProfileOptions {
  /** A candidate whose hit rate (validFrames/detectedFrames) falls below
   * this is disqualified outright, no matter how high its throughput
   * looked — a fast profile that mostly fails to decode isn't actually
   * fast. Mirrors `profileRecommender.ts`'s bad-quality threshold. */
  readonly minHitRate?: number;
}

const DEFAULT_MIN_HIT_RATE = 0.5;

/** Real, measured net payload rate — never a nominal `targetFps`-derived
 * estimate, matching Milestone 9.5's "UI zeigt nicht nur Roh-FPS, sondern
 * gültige Nutzdatenrate" (this is that same number, computed once per
 * candidate instead of continuously). */
function score(candidate: ProfileCandidate): number {
  return candidate.metrics.effectivePayloadBytesPerSecond;
}

function hitRate(metrics: ChannelQualityMetrics): number {
  return metrics.validFrames / Math.max(1, metrics.detectedFrames);
}

/**
 * Picks the highest-throughput profile among `candidates` whose hit rate
 * clears `minHitRate` — "robustestes Profil oberhalb einer Qualitätsgrenze
 * wählen" read the other way round (best *throughput* above a robustness
 * floor; equivalent framing, since profiles are already ordered
 * robust→dense in `profile.ts` and disqualifying low-hit-rate candidates
 * has the same effect as requiring a minimum robustness). Returns `null`
 * if nothing clears the bar — the caller (eventually a UI) decides what to
 * fall back to (most likely the most robust profile available).
 */
export function selectBestProfile(candidates: readonly ProfileCandidate[], options: SelectBestProfileOptions = {}): ChannelProfile | null {
  const minHitRate = options.minHitRate ?? DEFAULT_MIN_HIT_RATE;

  let best: ProfileCandidate | null = null;
  for (const candidate of candidates) {
    if (hitRate(candidate.metrics) < minHitRate) continue;
    if (!best || score(candidate) > score(best)) best = candidate;
  }
  return best?.profile ?? null;
}
