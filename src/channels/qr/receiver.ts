import jsQR from 'jsqr';
import { base45Decode } from '../../core/base45';
import type { CameraFrame, ChannelReceiver } from '../types';

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
declare const BarcodeDetector: (new (options?: { formats?: string[] }) => BarcodeDetectorLike) | undefined;

/**
 * Reads the QR stream. Prefers the browser's native BarcodeDetector (hardware-backed
 * on Android/Chrome, far faster than JS) and falls back to jsQR everywhere else,
 * notably iOS Safari.
 */
export class QrReceiver implements ChannelReceiver {
  readonly channel = 'qr' as const;
  /** jsQR's cost grows with pixel count, and QR modules stay legible well below native. */
  readonly preferredWidth = 800;

  private native: BarcodeDetectorLike | null = null;
  private busy = false;
  private lastHit = 0;
  private decodedFrames = 0;
  private readFrames = 0;

  constructor(private readonly onPacket: (bytes: Uint8Array) => void) {
    try {
      if (typeof BarcodeDetector !== 'undefined') this.native = new BarcodeDetector({ formats: ['qr_code'] });
    } catch {
      this.native = null;
    }
  }

  get status(): string {
    if (this.decodedFrames === 0) return 'Suche QR-Codes …';
    const stale = Date.now() - this.lastHit;
    if (stale > 1500) return 'Kein Code im Bild – Kamera ruhig halten';
    return `Empfang läuft · ${this.decodedFrames} Codes gelesen`;
  }

  get usingNative(): boolean {
    return this.native !== null;
  }

  async ingest(frame: CameraFrame): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.readFrames++;
    try {
      const text = this.native ? await this.detectNative(frame) : this.detectJs(frame);
      if (!text) return;

      const bytes = base45Decode(text);
      if (!bytes) return;

      this.decodedFrames++;
      this.lastHit = Date.now();
      this.onPacket(bytes);
    } finally {
      this.busy = false;
    }
  }

  private async detectNative(frame: CameraFrame): Promise<string | null> {
    try {
      const found = await this.native!.detect(frame.canvas);
      return found.length > 0 ? found[0].rawValue : null;
    } catch {
      // Some browsers advertise the API but throw on use; drop to the JS path for good.
      this.native = null;
      return this.detectJs(frame);
    }
  }

  private detectJs(frame: CameraFrame): string | null {
    const found = jsQR(frame.imageData.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
    return found ? found.data : null;
  }
}
