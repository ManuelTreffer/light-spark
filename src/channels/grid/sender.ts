import { FountainEncoder } from '../../core/fountain';
import { encodePacket, PACKET_HEADER_SIZE } from '../../core/packet';
import { encodeGridCells } from './codec';
import { renderGrid } from './render';
import { geometryFor, specFor, type GridPreset, type GridSpec } from './spec';
import type { BeamSource } from '../types';

export class GridBeamSource implements BeamSource {
  readonly channel = 'grid' as const;
  readonly fps: number;
  readonly bytesPerFrame: number;
  readonly chunkCount: number;
  readonly spec: GridSpec;

  private readonly encoder: FountainEncoder;
  private readonly streamId: number;
  private readonly chunkSize: number;
  private sent = 0;

  constructor(
    private readonly envelope: Uint8Array,
    preset: GridPreset,
  ) {
    this.spec = specFor(preset);
    this.fps = preset.fps;

    const geometry = geometryFor(this.spec);
    this.chunkSize = geometry.bodyBytes - PACKET_HEADER_SIZE;
    if (this.chunkSize < 16) throw new Error('Raster zu klein für ein Paket');

    this.bytesPerFrame = this.chunkSize;
    this.encoder = new FountainEncoder(envelope, this.chunkSize);
    this.chunkCount = this.encoder.chunkCount;
    this.streamId = Math.floor(Math.random() * 0xffff);
  }

  get framesSent(): number {
    return this.sent;
  }

  get estimatedSeconds(): number {
    return (this.chunkCount * 1.15) / this.fps;
  }

  get cellCount(): number {
    return geometryFor(this.spec).cellCount;
  }

  renderFrame(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const { seed, payload } = this.encoder.next();
    const packet = encodePacket({
      streamId: this.streamId,
      totalBytes: this.envelope.length,
      chunkSize: this.chunkSize,
      seed,
      payload,
    });

    renderGrid(ctx, width, height, encodeGridCells(packet, this.spec), this.spec);
    this.sent++;
  }
}
