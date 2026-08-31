import { PACKET_HEADER_SIZE } from '../core/packet';
import { QR_PRESETS } from './qr/sender';
import { BEACON_PRESETS } from './beacon/sender';
import { geometryFor, specFor, GRID_PRESETS } from './grid/spec';
import type { ChannelId } from './types';

export interface Estimate {
  seconds: number;
  /** Fountain chunks the receiver must collect; null for the beacon, which loops one message. */
  chunkCount: number | null;
  bytesPerFrame: number;
  fps: number;
}

/**
 * Extra frames beyond the chunk count. A receiver already watching catches the
 * systematic first pass and needs almost none; one that starts filming mid-transfer
 * lands in the coded region, where LT coding costs roughly 35%. This sits between.
 */
const FOUNTAIN_OVERHEAD = 1.2;

/**
 * How long a transfer will really take, from the actual envelope and preset rather
 * than a nominal throughput — compression can shrink a text payload tenfold, so a
 * size-based guess would be badly wrong exactly where users notice.
 */
export function estimate(channel: ChannelId, presetIndex: number, envelopeBytes: number, payloadBytes: number): Estimate {
  if (channel === 'beacon') {
    const preset = BEACON_PRESETS[presetIndex] ?? BEACON_PRESETS[1];
    // One delimiter, then four symbols each for the length byte, the payload, and the CRC.
    const symbols = 1 + (payloadBytes + 2) * 4;
    return { seconds: symbols / preset.fps, chunkCount: null, bytesPerFrame: 0.25, fps: preset.fps };
  }

  if (channel === 'qr') {
    const preset = QR_PRESETS[presetIndex] ?? QR_PRESETS[1];
    const chunkCount = Math.max(1, Math.ceil(envelopeBytes / preset.chunkSize));
    return {
      seconds: (chunkCount * FOUNTAIN_OVERHEAD) / preset.fps,
      chunkCount,
      bytesPerFrame: preset.chunkSize,
      fps: preset.fps,
    };
  }

  const preset = GRID_PRESETS[presetIndex] ?? GRID_PRESETS[1];
  const chunkSize = geometryFor(specFor(preset)).bodyBytes - PACKET_HEADER_SIZE;
  const chunkCount = Math.max(1, Math.ceil(envelopeBytes / chunkSize));
  return {
    seconds: (chunkCount * FOUNTAIN_OVERHEAD) / preset.fps,
    chunkCount,
    bytesPerFrame: chunkSize,
    fps: preset.fps,
  };
}
