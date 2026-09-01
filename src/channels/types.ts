export type ChannelId = 'qr' | 'grid' | 'beacon';

/** Something that paints one transmit frame per tick. */
export interface BeamSource {
  readonly channel: ChannelId;
  readonly fps: number;
  /** Bytes of envelope carried per frame, before fountain overhead. */
  readonly bytesPerFrame: number;
  /** Chunks the receiver must collect (null for the beacon, which loops a whole message). */
  readonly chunkCount: number | null;
  /** Estimated seconds for one full pass, for the sender's countdown. */
  readonly estimatedSeconds: number;
  renderFrame(ctx: CanvasRenderingContext2D, width: number, height: number): void;
  readonly framesSent: number;
}

/** One grabbed camera frame, prepared once per tick and shared by all decoders. */
export interface CameraFrame {
  imageData: ImageData;
  width: number;
  height: number;
  /** The canvas the frame was drawn into — the native BarcodeDetector prefers it. */
  canvas: HTMLCanvasElement;
}

export interface ChannelReceiver {
  readonly channel: ChannelId;
  ingest(frame: CameraFrame): Promise<void>;
  /** Short human-readable signal status shown under the viewfinder. */
  readonly status: string;
  /**
   * Working width the camera frame is scaled to before decoding. The grid needs
   * real resolution to resolve small cells; the beacon only averages a blob, and
   * jsQR gets slow well before 1280px.
   */
  readonly preferredWidth: number;
}

export interface ChannelMeta {
  id: ChannelId;
  name: string;
  icon: string;
  tagline: string;
  description: string;
  /** Rough throughput in bytes per second, for the channel recommendation. */
  throughput: number;
  /** Largest payload this channel is sensible for. */
  maxBytes: number;
}

export const CHANNELS: Record<ChannelId, ChannelMeta> = {
  beacon: {
    id: 'beacon',
    name: 'Blitz-Beacon',
    icon: '💡',
    tagline: 'Quer durch den Raum',
    description:
      'Der ganze Bildschirm blinkt in Farben. Langsam, aber du musst nicht zielen – das funktioniert auch aus einigen Metern Entfernung.',
    throughput: 2,
    maxBytes: 180,
  },
  qr: {
    id: 'qr',
    name: 'QR-Strom',
    icon: '📱',
    tagline: 'Robust und zuverlässig',
    description:
      'Ein Strom animierter QR-Codes. Der Klassiker – funktioniert praktisch immer, auch bei mittelmäßigem Licht.',
    throughput: 3000,
    maxBytes: 2 * 1024 * 1024,
  },
  grid: {
    id: 'grid',
    name: 'Spark Grid',
    icon: '🌈',
    tagline: 'Das schnelle Farbraster',
    description:
      'Ein Vollbild-Farbraster mit 3 Bit pro Zelle. Deutlich schneller als QR, will dafür eine ruhige Hand und gute Ausrichtung.',
    throughput: 12000,
    maxBytes: 8 * 1024 * 1024,
  },
};

/** Which channel suits a payload of this size. */
export function recommendChannel(byteLength: number): ChannelId {
  // Flash Beacon is temporarily disabled — real-world reception wasn't reliable
  // enough yet. Left commented out so it's easy to bring back later.
  // if (byteLength <= CHANNELS.beacon.maxBytes) return 'beacon';
  if (byteLength <= 24 * 1024) return 'qr';
  return 'grid';
}
