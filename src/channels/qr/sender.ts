import QRCode from 'qrcode';
import { FountainEncoder } from '../../core/fountain';
import { encodePacket, PACKET_HEADER_SIZE } from '../../core/packet';
import { base45Encode } from '../../core/base45';
import type { BeamSource } from '../types';

export interface QrPreset {
  id: 'safe' | 'normal' | 'turbo';
  label: string;
  hint: string;
  chunkSize: number;
  errorCorrection: 'L' | 'M';
  fps: number;
}

export const QR_PRESETS: QrPreset[] = [
  { id: 'safe', label: 'Sicher', hint: 'Große Module, viel Fehlerkorrektur', chunkSize: 160, errorCorrection: 'M', fps: 8 },
  { id: 'normal', label: 'Normal', hint: 'Guter Kompromiss', chunkSize: 340, errorCorrection: 'L', fps: 10 },
  { id: 'turbo', label: 'Turbo', hint: 'Dicht – braucht eine gute Kamera', chunkSize: 680, errorCorrection: 'L', fps: 12 },
];

export class QrBeamSource implements BeamSource {
  readonly channel = 'qr' as const;
  readonly fps: number;
  readonly bytesPerFrame: number;
  readonly chunkCount: number;

  private readonly encoder: FountainEncoder;
  private readonly streamId: number;
  private sent = 0;
  /** Cached so a re-render (resize, repaint) does not consume a fresh drop. */
  private current: { size: number; data: Uint8Array } | null = null;

  constructor(
    private readonly envelope: Uint8Array,
    private readonly preset: QrPreset,
  ) {
    this.fps = preset.fps;
    this.bytesPerFrame = preset.chunkSize;
    this.encoder = new FountainEncoder(envelope, preset.chunkSize);
    this.chunkCount = this.encoder.chunkCount;
    this.streamId = Math.floor(Math.random() * 0xffff);
  }

  get framesSent(): number {
    return this.sent;
  }

  /** Seconds for one nominal pass, plus the ~15% fountain overhead. */
  get estimatedSeconds(): number {
    return (this.chunkCount * 1.15) / this.fps;
  }

  advance(): void {
    const { seed, payload } = this.encoder.next();
    const packet = encodePacket({
      streamId: this.streamId,
      totalBytes: this.envelope.length,
      chunkSize: this.preset.chunkSize,
      seed,
      payload,
    });

    const qr = QRCode.create(base45Encode(packet), { errorCorrectionLevel: this.preset.errorCorrection });
    this.current = { size: qr.modules.size, data: qr.modules.data as unknown as Uint8Array };
    this.sent++;
  }

  renderFrame(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    this.advance();
    const frame = this.current!;

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    // A quiet zone is mandatory for scanners; 3 modules is comfortable.
    const quiet = 3;
    const total = frame.size + quiet * 2;
    const scale = Math.floor(Math.min(width, height) / total);
    const drawn = scale * total;
    const originX = Math.floor((width - drawn) / 2);
    const originY = Math.floor((height - drawn) / 2);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(originX, originY, drawn, drawn);

    ctx.fillStyle = '#000000';
    for (let y = 0; y < frame.size; y++) {
      for (let x = 0; x < frame.size; x++) {
        if (frame.data[y * frame.size + x]) {
          ctx.fillRect(originX + (x + quiet) * scale, originY + (y + quiet) * scale, scale, scale);
        }
      }
    }
  }

  /**
   * Side of the QR symbol in modules, for judging whether a preset stays scannable.
   * Built from a stand-in packet so that asking does not consume a drop.
   */
  get moduleCount(): number {
    const sample = encodePacket({
      streamId: 0,
      totalBytes: this.envelope.length,
      chunkSize: this.preset.chunkSize,
      seed: 0,
      payload: new Uint8Array(this.preset.chunkSize).fill(0xa5),
    });
    return QRCode.create(base45Encode(sample), { errorCorrectionLevel: this.preset.errorCorrection }).modules.size;
  }

  get packetBytes(): number {
    return PACKET_HEADER_SIZE + this.preset.chunkSize;
  }
}
