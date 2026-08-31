import { describe, it, expect } from 'vitest';
import jsQR from 'jsqr';
import { QrBeamSource, QR_PRESETS } from './sender';
import { base45Decode } from '../../core/base45';
import { TransferAssembler } from '../../core/assembler';
import { buildEnvelope, payloadFromText, type ReceivedPayload } from '../../core/protocol';
import { mulberry32 } from '../../core/rng';

/**
 * Full QR channel loopback, decoder included.
 *
 * jsQR is plain JavaScript and the sender paints with nothing but fillRect, so the
 * whole path — packet, base45, real QR symbol, real QR decode, fountain reassembly,
 * envelope — runs here without a browser.
 */

/** Minimal 2D context over a raw RGBA buffer; fillRect is all the sender uses. */
function fakeCanvas(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  let fill = { r: 0, g: 0, b: 0 };

  const ctx = {
    set fillStyle(value: string) {
      fill = {
        r: parseInt(value.slice(1, 3), 16),
        g: parseInt(value.slice(3, 5), 16),
        b: parseInt(value.slice(5, 7), 16),
      };
    },
    fillRect(x: number, y: number, w: number, h: number) {
      const x0 = Math.max(0, Math.round(x));
      const y0 = Math.max(0, Math.round(y));
      const x1 = Math.min(width, Math.round(x + w));
      const y1 = Math.min(height, Math.round(y + h));
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const i = (py * width + px) * 4;
          data[i] = fill.r;
          data[i + 1] = fill.g;
          data[i + 2] = fill.b;
        }
      }
    },
  } as unknown as CanvasRenderingContext2D;

  return { ctx, data };
}

interface RunOptions {
  /** Fraction of frames the camera never catches. */
  loss?: number;
  size?: number;
  maxFrames?: number;
  seed?: number;
}

async function runTransfer(text: string, presetIndex: number, options: RunOptions = {}) {
  const { loss = 0, size = 900, maxFrames = 4000, seed = 7 } = options;

  const payload = payloadFromText(text);
  const envelope = await buildEnvelope(payload);
  const source = new QrBeamSource(envelope, QR_PRESETS[presetIndex]);

  let received: ReceivedPayload | null = null;
  const assembler = new TransferAssembler(
    () => undefined,
    (result) => {
      received = result;
    },
  );

  const rand = mulberry32(seed);
  let sent = 0;
  let read = 0;

  while (!received && sent < maxFrames) {
    const { ctx, data } = fakeCanvas(size, size);
    source.renderFrame(ctx, size, size);
    sent++;
    if (rand() < loss) continue;

    const found = jsQR(data, size, size, { inversionAttempts: 'dontInvert' });
    if (!found) continue;

    const bytes = base45Decode(found.data);
    if (!bytes) continue;
    read++;
    assembler.ingestPacket(bytes);

    // The assembler finishes asynchronously (inflate is stream-based).
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return { received: received as ReceivedPayload | null, sent, read, source };
}

describe('qr channel loopback', () => {
  it('carries a message end to end at every preset', async () => {
    const text = 'Light Spark überträgt das hier ohne WLAN, ohne Bluetooth — nur mit Licht. 🔦';

    for (let index = 0; index < QR_PRESETS.length; index++) {
      const { received, read } = await runTransfer(text, index, { maxFrames: 400 });
      expect(received, `${QR_PRESETS[index].label}: nothing arrived`).not.toBeNull();
      expect(received!.verified, QR_PRESETS[index].label).toBe(true);
      expect(new TextDecoder().decode(received!.data)).toBe(text);
      expect(read).toBeGreaterThan(0);
    }
  }, 60000);

  it('completes despite half the frames never being caught', async () => {
    const text = 'Ein längerer Text, damit mehrere Chunks nötig sind. '.repeat(30);
    const { received, sent, read } = await runTransfer(text, 1, { loss: 0.5, maxFrames: 600 });

    expect(received).not.toBeNull();
    expect(received!.verified).toBe(true);
    expect(new TextDecoder().decode(received!.data)).toBe(text);
    expect(read).toBeLessThan(sent); // frames really were dropped
  }, 60000);

  it('needs only a modest surplus of frames over chunks', async () => {
    // Incompressible on purpose: repetitive text deflates down to a single chunk,
    // which would measure nothing about the fountain code's overhead. It also needs
    // to be big enough for a few dozen chunks — the sender seeds itself randomly, and
    // at a handful of chunks the overhead ratio swings too much to assert on.
    const rand = mulberry32(4242);
    let text = '';
    for (let i = 0; i < 16000; i++) text += String.fromCharCode(33 + Math.floor(rand() * 90));

    const { received, read, source } = await runTransfer(text, 1, { maxFrames: 900 });

    expect(received).not.toBeNull();
    expect(new TextDecoder().decode(received!.data)).toBe(text);
    expect(source.chunkCount).toBeGreaterThan(25);
    // Anything approaching 2x would mean the degree distribution is misbehaving.
    expect(read).toBeLessThan(source.chunkCount * 1.7);
  }, 60000);

  it('produces QR symbols a phone camera can realistically resolve', async () => {
    for (const preset of QR_PRESETS) {
      const source = new QrBeamSource(await buildEnvelope(payloadFromText('x'.repeat(4000))), preset);
      // Beyond ~120 modules the cells get too fine to film off a laptop screen.
      expect(source.moduleCount, preset.label).toBeLessThanOrEqual(121);
    }
  });
});
