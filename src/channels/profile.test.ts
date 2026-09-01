import { describe, it, expect } from 'vitest';
import { SPARK_GRID_PROFILES, QR_PROFILES, ALL_PROFILES, findProfile } from './profile';
import { GRID_PRESETS, GRID_PALETTES } from './grid/spec';
import { QR_PRESETS } from './qr/sender';
import { QualityWindow, type ChannelQualityMetrics } from './qualityMetrics';
import { ProfileRecommender } from './profileRecommender';
import { selectBestProfile, type ProfileCandidate } from './calibration';

describe('Channel profiles — derived from existing presets, not invented', () => {
  it('Spark Grid profiles match GRID_PRESETS exactly, in robust-to-dense order', () => {
    expect(SPARK_GRID_PROFILES.map((p) => p.id)).toEqual(['spark-robust', 'spark-balanced', 'spark-dense']);

    const bySourceId: Record<string, (typeof GRID_PRESETS)[number]['id']> = {
      'spark-robust': 'safe',
      'spark-balanced': 'normal',
      'spark-dense': 'turbo',
    };
    for (const profile of SPARK_GRID_PROFILES) {
      const source = GRID_PRESETS.find((p) => p.id === bySourceId[profile.id])!;
      expect(profile.targetFps).toBe(source.fps);
      expect(profile.gridColumns).toBe(source.cells);
      expect(profile.gridRows).toBe(source.cells);
      expect(profile.bitsPerCell).toBe(GRID_PALETTES[source.paletteId].bitsPerCell);
      expect(profile.channel).toBe('spark-grid');
    }

    // Monotonically more demanding, robust to dense.
    for (let i = 1; i < SPARK_GRID_PROFILES.length; i++) {
      expect(SPARK_GRID_PROFILES[i].gridColumns!).toBeGreaterThan(SPARK_GRID_PROFILES[i - 1].gridColumns!);
    }
  });

  it('QR profiles match QR_PRESETS, error correction mapped L < M < Q < H', () => {
    expect(QR_PROFILES.map((p) => p.id)).toEqual(['qr-robust', 'qr-fast']);

    const robustSource = QR_PRESETS.find((p) => p.id === 'safe')!;
    const fastSource = QR_PRESETS.find((p) => p.id === 'turbo')!;

    expect(QR_PROFILES[0].targetFps).toBe(robustSource.fps);
    expect(QR_PROFILES[0].errorCorrectionLevel).toBe(1); // 'M'
    expect(QR_PROFILES[1].targetFps).toBe(fastSource.fps);
    expect(QR_PROFILES[1].errorCorrectionLevel).toBe(0); // 'L'
    expect(QR_PROFILES.every((p) => p.channel === 'qr')).toBe(true);
  });

  it('findProfile looks up by id across all channels, undefined for unknown', () => {
    expect(findProfile('spark-dense')?.channel).toBe('spark-grid');
    expect(findProfile('qr-robust')?.channel).toBe('qr');
    expect(findProfile('does-not-exist')).toBeUndefined();
    expect(ALL_PROFILES.length).toBe(SPARK_GRID_PROFILES.length + QR_PROFILES.length);
  });

  it('tileColumns/tileRows and calibrationInterval/fullMarkerInterval are left unset — no invented values', () => {
    for (const profile of ALL_PROFILES) {
      expect(profile.tileColumns).toBeUndefined();
      expect(profile.tileRows).toBeUndefined();
      expect(profile.calibrationInterval).toBeUndefined();
      expect(profile.fullMarkerInterval).toBeUndefined();
    }
  });
});

describe('QualityWindow — real measured metrics, not FPS estimation', () => {
  it('never touches a clock for anything except elapsed-time-based effectivePayloadBytesPerSecond', () => {
    let clock = 0;
    const window = new QualityWindow({ now: () => clock });

    window.recordCapturedFrame();
    window.recordCapturedFrame();
    window.recordDetectedFrame();
    window.recordValidFrame(100, 20);
    window.recordInvalidFrame(15);
    window.recordTile(true);
    window.recordTile(true);
    window.recordTile(false);
    window.recordClassificationConfidence(0.8);
    window.recordClassificationConfidence(0.6);

    clock = 2000; // 2 real seconds elapsed
    const snapshot = window.snapshot();

    expect(snapshot.capturedFrames).toBe(2);
    expect(snapshot.detectedFrames).toBe(1);
    expect(snapshot.validFrames).toBe(1);
    expect(snapshot.invalidFrames).toBe(1);
    expect(snapshot.validTiles).toBe(2);
    expect(snapshot.invalidTiles).toBe(1);
    expect(snapshot.averageClassificationConfidence).toBeCloseTo(0.7);
    expect(snapshot.processingTimeMs).toBeCloseTo((20 + 15) / 2);
    expect(snapshot.effectivePayloadBytesPerSecond).toBeCloseTo(100 / 2); // 100 bytes over 2 real seconds
  });

  it('clamps out-of-range confidence rather than skewing the average silently', () => {
    const window = new QualityWindow({ now: () => 0 });
    window.recordClassificationConfidence(1.5);
    window.recordClassificationConfidence(-0.5);
    expect(window.snapshot().averageClassificationConfidence).toBeCloseTo(0.5); // clamped to 1 and 0
  });

  it('an empty window snapshots to well-defined zeros, never NaN', () => {
    const window = new QualityWindow({ now: () => 1000 });
    const snapshot = window.snapshot();
    expect(Number.isFinite(snapshot.averageClassificationConfidence)).toBe(true);
    expect(Number.isFinite(snapshot.processingTimeMs)).toBe(true);
    expect(Number.isFinite(snapshot.effectivePayloadBytesPerSecond)).toBe(true);
    expect(snapshot.effectivePayloadBytesPerSecond).toBe(0);
  });
});

describe('ProfileRecommender — hysteresis', () => {
  const profiles = [
    { id: 'a', channel: 'spark-grid' as const, targetFps: 8 },
    { id: 'b', channel: 'spark-grid' as const, targetFps: 10 },
    { id: 'c', channel: 'spark-grid' as const, targetFps: 12 },
  ];

  function goodWindow(overrides: Partial<ChannelQualityMetrics> = {}): ChannelQualityMetrics {
    return {
      capturedFrames: 20,
      detectedFrames: 20,
      validFrames: 19,
      invalidFrames: 1,
      validTiles: 0,
      invalidTiles: 0,
      averageClassificationConfidence: 0.95,
      processingTimeMs: 5,
      effectivePayloadBytesPerSecond: 1000,
      ...overrides,
    };
  }

  function badWindow(overrides: Partial<ChannelQualityMetrics> = {}): ChannelQualityMetrics {
    return {
      capturedFrames: 20,
      detectedFrames: 20,
      validFrames: 5,
      invalidFrames: 15,
      validTiles: 0,
      invalidTiles: 0,
      averageClassificationConfidence: 0.3,
      processingTimeMs: 5,
      effectivePayloadBytesPerSecond: 100,
      ...overrides,
    };
  }

  it('recommends a more robust profile after enough consecutive bad windows, past the cooldown', () => {
    let clock = 0;
    const recommender = new ProfileRecommender(profiles, 'b', { now: () => clock, minDurationMsPerProfile: 1000 });

    clock = 1500; // past the cooldown for every window below
    expect(recommender.recordWindow(badWindow())).toBe('stay'); // 1st bad window, default threshold is 2
    expect(recommender.recordWindow(badWindow())).toBe('more-robust'); // 2nd
    expect(recommender.currentProfile.id).toBe('a');
  });

  it('recommends a denser profile only after a longer good streak than the robust side needs', () => {
    let clock = 0;
    const recommender = new ProfileRecommender(profiles, 'b', { now: () => clock, minDurationMsPerProfile: 1000 });
    clock = 1500;

    for (let i = 0; i < 4; i++) {
      expect(recommender.recordWindow(goodWindow())).toBe('stay'); // default threshold is 5
    }
    expect(recommender.recordWindow(goodWindow())).toBe('denser');
    expect(recommender.currentProfile.id).toBe('c');
  });

  it('never recommends anything before minDurationMsPerProfile has elapsed, even with a qualifying streak', () => {
    let clock = 0;
    const recommender = new ProfileRecommender(profiles, 'b', {
      now: () => clock,
      minDurationMsPerProfile: 5000,
      minBadWindowsBeforeRobust: 1,
    });
    clock = 1000; // still within the cooldown
    expect(recommender.recordWindow(badWindow())).toBe('stay');
    expect(recommender.currentProfile.id).toBe('b');
  });

  it('does not recommend below the most robust profile, or above the densest', () => {
    let clock = 0;
    const atFloor = new ProfileRecommender(profiles, 'a', { now: () => clock, minDurationMsPerProfile: 0, minBadWindowsBeforeRobust: 1 });
    expect(atFloor.recordWindow(badWindow())).toBe('stay');
    expect(atFloor.currentProfile.id).toBe('a');

    const atCeiling = new ProfileRecommender(profiles, 'c', { now: () => clock, minDurationMsPerProfile: 0, minGoodWindowsBeforeDenser: 1 });
    expect(atCeiling.recordWindow(goodWindow())).toBe('stay');
    expect(atCeiling.currentProfile.id).toBe('c');
  });

  it('an overloaded device (processing slower than its own frame interval) never gets recommended denser', () => {
    let clock = 0;
    const recommender = new ProfileRecommender(profiles, 'b', {
      now: () => clock,
      minDurationMsPerProfile: 0,
      minGoodWindowsBeforeDenser: 1,
    });
    // profile 'b' targets 10fps -> 100ms budget; 150ms processing blows that budget.
    expect(recommender.recordWindow(goodWindow({ processingTimeMs: 150 }))).toBe('stay');
    expect(recommender.currentProfile.id).toBe('b');
  });

  it('a window with too few detected frames is ignored — neither builds nor breaks a streak', () => {
    let clock = 0;
    const recommender = new ProfileRecommender(profiles, 'b', {
      now: () => clock,
      minDurationMsPerProfile: 0,
      minBadWindowsBeforeRobust: 2,
      minSamplesPerWindow: 5,
    });
    expect(recommender.recordWindow(badWindow())).toBe('stay'); // streak = 1
    expect(recommender.recordWindow(badWindow({ detectedFrames: 2, validFrames: 2 }))).toBe('stay'); // too few samples, ignored
    expect(recommender.recordWindow(badWindow())).toBe('more-robust'); // streak = 2, not reset by the ignored window
  });

  it('a middling window (neither good nor bad) does not reset an in-progress streak', () => {
    let clock = 0;
    const recommender = new ProfileRecommender(profiles, 'b', { now: () => clock, minDurationMsPerProfile: 0, minBadWindowsBeforeRobust: 2 });
    expect(recommender.recordWindow(badWindow())).toBe('stay'); // streak = 1
    expect(recommender.recordWindow(badWindow({ validFrames: 14, invalidFrames: 6 }))).toBe('stay'); // hit rate 0.7 — middling, doesn't reset
    expect(recommender.recordWindow(badWindow())).toBe('more-robust'); // streak still completes at 2
  });

  it('manual override changes the profile immediately and resets hysteresis', () => {
    let clock = 0;
    const recommender = new ProfileRecommender(profiles, 'c', { now: () => clock, minDurationMsPerProfile: 1000, minBadWindowsBeforeRobust: 2 });
    clock = 1500;
    expect(recommender.recordWindow(badWindow())).toBe('stay'); // bad streak = 1 of 2 needed

    // A manual override to a different profile, mid-streak.
    recommender.overrideProfile('b');
    expect(recommender.currentProfile.id).toBe('b');

    // If the pre-override streak had survived, one more bad window would
    // complete it (1 + 1 = 2) and switch immediately. It doesn't: the
    // override reset the count, so this is only streak 1 of 2 again.
    clock = 3000; // past the cooldown the override also restarted
    expect(recommender.recordWindow(badWindow())).toBe('stay');
    expect(recommender.currentProfile.id).toBe('b');
    expect(recommender.recordWindow(badWindow())).toBe('more-robust'); // now streak 2 of 2
    expect(recommender.currentProfile.id).toBe('a');
  });

  it('rejects an unknown starting or override profile id', () => {
    expect(() => new ProfileRecommender(profiles, 'nope')).toThrow();
    const recommender = new ProfileRecommender(profiles, 'a');
    expect(() => recommender.overrideProfile('nope')).toThrow();
  });
});

describe('selectBestProfile — calibration scoring', () => {
  function metrics(overrides: Partial<ChannelQualityMetrics>): ChannelQualityMetrics {
    return {
      capturedFrames: 10,
      detectedFrames: 10,
      validFrames: 10,
      invalidFrames: 0,
      validTiles: 0,
      invalidTiles: 0,
      averageClassificationConfidence: 1,
      processingTimeMs: 5,
      effectivePayloadBytesPerSecond: 0,
      ...overrides,
    };
  }

  it('picks the highest-throughput candidate that clears the hit-rate floor', () => {
    const candidates: ProfileCandidate[] = [
      { profile: SPARK_GRID_PROFILES[0], metrics: metrics({ effectivePayloadBytesPerSecond: 500 }) },
      { profile: SPARK_GRID_PROFILES[1], metrics: metrics({ effectivePayloadBytesPerSecond: 2000 }) },
      { profile: SPARK_GRID_PROFILES[2], metrics: metrics({ effectivePayloadBytesPerSecond: 1500 }) },
    ];
    expect(selectBestProfile(candidates)?.id).toBe('spark-balanced');
  });

  it('disqualifies a high-throughput candidate whose hit rate is too low', () => {
    const candidates: ProfileCandidate[] = [
      { profile: SPARK_GRID_PROFILES[0], metrics: metrics({ effectivePayloadBytesPerSecond: 500 }) },
      {
        profile: SPARK_GRID_PROFILES[2],
        metrics: metrics({ effectivePayloadBytesPerSecond: 9000, validFrames: 2, detectedFrames: 10 }), // hit rate 0.2
      },
    ];
    expect(selectBestProfile(candidates)?.id).toBe('spark-robust');
  });

  it('returns null when nothing clears the floor, or there are no candidates at all', () => {
    expect(selectBestProfile([])).toBeNull();
    const allBad: ProfileCandidate[] = [{ profile: SPARK_GRID_PROFILES[0], metrics: metrics({ validFrames: 1, detectedFrames: 10 }) }];
    expect(selectBestProfile(allBad)).toBeNull();
  });
});
