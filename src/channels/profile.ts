import { GRID_PRESETS, GRID_PALETTES } from './grid/spec';
import { QR_PRESETS } from './qr/sender';

/**
 * Channel profiles (Milestone 6.1). Field names match the roadmap's own
 * sketch. Every starting profile below is derived directly from an
 * existing, already-shipped preset (`GRID_PRESETS`/`QR_PRESETS`) — per the
 * roadmap's explicit "Werte anhand der bestehenden Implementierung
 * bestimmen und nicht willkürlich fest verdrahten" — not invented.
 *
 * `tileColumns`/`tileRows` are left `undefined` in every starting profile:
 * PR 4's Spark Grid tiling (`channels/grid/tiles.ts`) has no live sender
 * wiring yet and therefore no measured data on what tiling density is
 * actually worth using at which preset — inventing numbers here would
 * violate the same "not willkürlich" rule the roadmap states for the rest
 * of this file. Populate once a real sender picks tile densities.
 *
 * `calibrationInterval`/`fullMarkerInterval` (Milestone 7, Keyframes and
 * compact frames) are likewise left `undefined` — that milestone doesn't
 * exist in this codebase yet, so there's nothing to derive real values from.
 */
export interface ChannelProfile {
  readonly id: string;
  readonly channel: 'beacon' | 'qr' | 'spark-grid';
  readonly targetFps: number;
  readonly gridColumns?: number;
  readonly gridRows?: number;
  readonly bitsPerCell?: number;
  readonly tileColumns?: number;
  readonly tileRows?: number;
  /** Frames between full keyframes once Milestone 7 exists — see doc comment above. */
  readonly calibrationInterval?: number;
  readonly fullMarkerInterval?: number;
  /** `0..3` mirroring QR's L/M/Q/H error-correction levels, in that
   * increasing-robustness order — chosen because the roadmap's own sketch
   * types this as a plain `number`, and QR error correction is the only
   * existing concept in this codebase it could plausibly refer to. */
  readonly errorCorrectionLevel?: number;
}

const QR_EC_LEVEL: Record<'L' | 'M' | 'Q' | 'H', number> = { L: 0, M: 1, Q: 2, H: 3 };

function gridProfile(id: string, presetId: (typeof GRID_PRESETS)[number]['id']): ChannelProfile {
  const preset = GRID_PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`unknown grid preset ${presetId}`);
  return {
    id,
    channel: 'spark-grid',
    targetFps: preset.fps,
    gridColumns: preset.cells,
    gridRows: preset.cells, // Spark Grid's data area is always square — see grid/spec.ts's GridSpec
    bitsPerCell: GRID_PALETTES[preset.paletteId].bitsPerCell,
  };
}

function qrProfile(id: string, presetId: (typeof QR_PRESETS)[number]['id']): ChannelProfile {
  const preset = QR_PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`unknown QR preset ${presetId}`);
  return {
    id,
    channel: 'qr',
    targetFps: preset.fps,
    errorCorrectionLevel: QR_EC_LEVEL[preset.errorCorrection],
  };
}

/**
 * Starting profiles (Milestone 6.1), ordered from most robust to densest
 * within each channel family — that ordering is load-bearing for
 * `profileRecommender.ts`, which only ever recommends moving one step up or
 * down a channel's own list, never jumping channels.
 */
export const SPARK_GRID_PROFILES: readonly ChannelProfile[] = [
  gridProfile('spark-robust', 'safe'),
  gridProfile('spark-balanced', 'normal'),
  gridProfile('spark-dense', 'turbo'),
];

export const QR_PROFILES: readonly ChannelProfile[] = [qrProfile('qr-robust', 'safe'), qrProfile('qr-fast', 'turbo')];

export const ALL_PROFILES: readonly ChannelProfile[] = [...SPARK_GRID_PROFILES, ...QR_PROFILES];

export function findProfile(id: string): ChannelProfile | undefined {
  return ALL_PROFILES.find((p) => p.id === id);
}
