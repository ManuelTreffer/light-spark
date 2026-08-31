import { FountainDecoder } from './fountain';
import { decodePacket } from './packet';
import { parseEnvelope, type ReceivedPayload } from './protocol';

export interface AssemblerState {
  /** True once packets are arriving and we know how big the transfer is. */
  locked: boolean;
  chunkCount: number;
  recoveredCount: number;
  progress: number;
  totalBytes: number;
  /** Per-chunk arrival, for the progress grid. */
  mask: boolean[];
  packetsSeen: number;
  startedAt: number | null;
}

const EMPTY: AssemblerState = {
  locked: false,
  chunkCount: 0,
  recoveredCount: 0,
  progress: 0,
  totalBytes: 0,
  mask: [],
  packetsSeen: 0,
  startedAt: null,
};

/**
 * Collects fountain drops from whichever channel is running and rebuilds the file.
 *
 * Channel decoders hand raw packet bytes to `ingestPacket` and stay out of the
 * reassembly business entirely, so QR and grid share all of this.
 */
export class TransferAssembler {
  private decoder: FountainDecoder | null = null;
  private streamId: number | null = null;
  private packetsSeen = 0;
  private startedAt: number | null = null;
  private finished = false;

  constructor(
    private readonly onUpdate: (state: AssemblerState) => void,
    private readonly onComplete: (payload: ReceivedPayload) => void,
  ) {}

  get state(): AssemblerState {
    if (!this.decoder) return { ...EMPTY, packetsSeen: this.packetsSeen };
    return {
      locked: true,
      chunkCount: this.decoder.chunkCount,
      recoveredCount: this.decoder.recoveredCount,
      progress: this.decoder.progress,
      totalBytes: this.decoder.totalBytes,
      mask: this.decoder.knownMask,
      packetsSeen: this.packetsSeen,
      startedAt: this.startedAt,
    };
  }

  reset(): void {
    this.decoder = null;
    this.streamId = null;
    this.packetsSeen = 0;
    this.startedAt = null;
    this.finished = false;
    this.onUpdate(this.state);
  }

  ingestPacket(bytes: Uint8Array): void {
    if (this.finished) return;

    const packet = decodePacket(bytes);
    if (!packet) return;

    // A different stream id means the sender moved on to another file; start over
    // rather than mixing two transfers into one corrupt blob.
    if (this.streamId !== packet.streamId || !this.decoder) {
      this.streamId = packet.streamId;
      this.decoder = new FountainDecoder(packet.totalBytes, packet.chunkSize);
      this.packetsSeen = 0;
      this.startedAt = Date.now();
    }

    this.packetsSeen++;
    this.decoder.addDrop(packet.seed, packet.payload);
    this.onUpdate(this.state);

    if (this.decoder.isComplete) void this.finish(this.decoder.getData()!);
  }

  /** For the beacon, which carries a whole (tiny) envelope rather than fountain drops. */
  ingestEnvelope(bytes: Uint8Array): void {
    if (this.finished) return;
    void this.finish(bytes);
  }

  private async finish(envelope: Uint8Array): Promise<void> {
    const payload = await parseEnvelope(envelope);
    if (!payload) {
      // Reassembled cleanly but isn't ours — most likely a stale half-transfer.
      this.decoder = null;
      this.streamId = null;
      return;
    }
    this.finished = true;
    this.onComplete(payload);
  }
}
