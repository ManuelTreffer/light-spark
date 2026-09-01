import type { ChannelProfile } from './profile';
import type { ChannelQualityMetrics } from './qualityMetrics';

/**
 * Local profile-switch recommendation, with hysteresis (Milestone 6.3).
 * "Zunächst nur lokale Empfehlung" — this class only ever *recommends*; it
 * never touches any sender, camera, or UI state itself, and has no
 * dependency on a feedback channel (there isn't one yet — Milestone 10).
 * A future automatic sender-side switch, once Milestone 10 exists, would
 * still go through the same recommendation logic, just wired to act on it
 * automatically instead of only surfacing it.
 */
export type ProfileRecommendation = 'stay' | 'more-robust' | 'denser';

export interface ProfileRecommenderOptions {
  /** Consecutive good windows required before recommending a denser
   * profile — the roadmap frames this as needing "längere stabile
   * Qualität", hence a higher default than the robust-side threshold. */
  readonly minGoodWindowsBeforeDenser?: number;
  /** Consecutive bad windows required before recommending a more robust
   * profile — "nach mehreren schlechten Messfenstern", a lower bar than
   * the denser side, since a struggling receiver should recover quickly. */
  readonly minBadWindowsBeforeRobust?: number;
  /** Minimum time on the current profile before *any* switch is
   * recommended, regardless of streaks — "Mindestdauer pro Profil". */
  readonly minDurationMsPerProfile?: number;
  readonly goodHitRateThreshold?: number;
  readonly badHitRateThreshold?: number;
  /** Below this many detected frames, a window's hit rate is too noisy to
   * trust — it counts toward neither streak (but doesn't reset one already
   * building, either). */
  readonly minSamplesPerWindow?: number;
  /** Injectable for deterministic tests — defaults to `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_MIN_GOOD_WINDOWS_BEFORE_DENSER = 5;
const DEFAULT_MIN_BAD_WINDOWS_BEFORE_ROBUST = 2;
const DEFAULT_MIN_DURATION_MS_PER_PROFILE = 10_000;
const DEFAULT_GOOD_HIT_RATE_THRESHOLD = 0.9;
const DEFAULT_BAD_HIT_RATE_THRESHOLD = 0.5;
const DEFAULT_MIN_SAMPLES_PER_WINDOW = 5;

/**
 * Walks up or down one channel's own, already-ordered profile list
 * (`SPARK_GRID_PROFILES`/`QR_PROFILES` in `profile.ts`, robust-to-dense) —
 * never across channels. One instance tracks one receiving session.
 */
export class ProfileRecommender {
  private readonly profiles: readonly ChannelProfile[];
  private readonly now: () => number;
  private readonly minGoodWindowsBeforeDenser: number;
  private readonly minBadWindowsBeforeRobust: number;
  private readonly minDurationMsPerProfile: number;
  private readonly goodHitRateThreshold: number;
  private readonly badHitRateThreshold: number;
  private readonly minSamplesPerWindow: number;

  private currentIndex: number;
  private switchedAt: number;
  private goodStreak = 0;
  private badStreak = 0;

  constructor(profiles: readonly ChannelProfile[], startProfileId: string, options: ProfileRecommenderOptions = {}) {
    if (profiles.length === 0) throw new Error('profiles must not be empty');
    const index = profiles.findIndex((p) => p.id === startProfileId);
    if (index < 0) throw new Error(`unknown starting profile "${startProfileId}"`);

    this.profiles = profiles;
    this.currentIndex = index;
    this.now = options.now ?? Date.now;
    this.switchedAt = this.now();
    this.minGoodWindowsBeforeDenser = options.minGoodWindowsBeforeDenser ?? DEFAULT_MIN_GOOD_WINDOWS_BEFORE_DENSER;
    this.minBadWindowsBeforeRobust = options.minBadWindowsBeforeRobust ?? DEFAULT_MIN_BAD_WINDOWS_BEFORE_ROBUST;
    this.minDurationMsPerProfile = options.minDurationMsPerProfile ?? DEFAULT_MIN_DURATION_MS_PER_PROFILE;
    this.goodHitRateThreshold = options.goodHitRateThreshold ?? DEFAULT_GOOD_HIT_RATE_THRESHOLD;
    this.badHitRateThreshold = options.badHitRateThreshold ?? DEFAULT_BAD_HIT_RATE_THRESHOLD;
    this.minSamplesPerWindow = options.minSamplesPerWindow ?? DEFAULT_MIN_SAMPLES_PER_WINDOW;
  }

  get currentProfile(): ChannelProfile {
    return this.profiles[this.currentIndex];
  }

  /** Manual override (Milestone 9.3's "manueller Override bleibt
   * möglich") — resets hysteresis state exactly like a real switch would,
   * so a user's choice isn't immediately second-guessed by streaks left
   * over from before they intervened. */
  overrideProfile(profileId: string): void {
    const index = this.profiles.findIndex((p) => p.id === profileId);
    if (index < 0) throw new Error(`unknown profile "${profileId}"`);
    this.currentIndex = index;
    this.resetHysteresis();
  }

  /**
   * Feeds one measurement window's metrics and returns what (if anything)
   * is recommended. Never applies the change itself — a caller (eventually
   * a UI) decides whether and when to act on it.
   */
  recordWindow(metrics: ChannelQualityMetrics): ProfileRecommendation {
    if (metrics.detectedFrames >= this.minSamplesPerWindow) {
      const hitRate = metrics.validFrames / Math.max(1, metrics.detectedFrames);
      if (hitRate <= this.badHitRateThreshold) {
        this.badStreak++;
        this.goodStreak = 0;
      } else if (hitRate >= this.goodHitRateThreshold) {
        this.goodStreak++;
        this.badStreak = 0;
      }
      // A window that's neither clearly good nor bad extends neither
      // streak, but doesn't reset one already building either — one
      // middling window shouldn't erase several consecutive good/bad ones.
    }

    if (this.now() - this.switchedAt < this.minDurationMsPerProfile) return 'stay';

    if (this.badStreak >= this.minBadWindowsBeforeRobust && this.currentIndex > 0) {
      this.currentIndex--;
      this.resetHysteresis();
      return 'more-robust';
    }

    // Milestone 9.5: "Überlastete Geräte wechseln nicht auf Profile, deren
    // Verarbeitung länger als das Frameintervall dauert" — checked against
    // the *current* profile's frame budget, since that's the rate this
    // device has actually been measured keeping up with (or not).
    const frameIntervalMs = 1000 / this.currentProfile.targetFps;
    const overloaded = metrics.processingTimeMs >= frameIntervalMs;

    if (!overloaded && this.goodStreak >= this.minGoodWindowsBeforeDenser && this.currentIndex < this.profiles.length - 1) {
      this.currentIndex++;
      this.resetHysteresis();
      return 'denser';
    }

    return 'stay';
  }

  private resetHysteresis(): void {
    this.goodStreak = 0;
    this.badStreak = 0;
    this.switchedAt = this.now();
  }
}
