import { describe, it, expect } from 'vitest';
import { crc32, crc8 } from './crc32';
import { base45Encode, base45Decode } from './base45';
import { FountainEncoder, FountainDecoder, pickIndices } from './fountain';
import { encodePacket, decodePacket } from './packet';
import { buildEnvelope, parseEnvelope, payloadFromText } from './protocol';
import { mulberry32 } from './rng';

function randomBytes(n: number, seed = 1): Uint8Array {
  const rand = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

describe('crc32', () => {
  it('matches the known check value for "123456789"', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('changes when a single bit flips', () => {
    const a = randomBytes(500);
    const b = a.slice();
    b[123] ^= 0x01;
    expect(crc32(a)).not.toBe(crc32(b));
  });
});

describe('crc8', () => {
  it('matches the known check value for "123456789"', () => {
    expect(crc8(new TextEncoder().encode('123456789'))).toBe(0xf4);
  });
});

describe('base45', () => {
  it('matches the RFC 9285 vectors', () => {
    expect(base45Encode(new TextEncoder().encode('AB'))).toBe('BB8');
    expect(base45Encode(new TextEncoder().encode('Hello!!'))).toBe('%69 VD92EX0');
    expect(base45Encode(new TextEncoder().encode('base-45'))).toBe('UJCLQE7W581');
  });

  it('round-trips arbitrary binary of both parities', () => {
    for (const size of [0, 1, 2, 3, 255, 256, 1000]) {
      const data = randomBytes(size, size + 7);
      const decoded = base45Decode(base45Encode(data));
      expect(decoded, `size ${size}`).not.toBeNull();
      expect(Array.from(decoded!), `size ${size}`).toEqual(Array.from(data));
    }
  });

  it('rejects garbled input instead of returning junk', () => {
    expect(base45Decode('A')).toBeNull(); // length % 3 === 1
    expect(base45Decode('ab8')).toBeNull(); // lowercase is outside the alphabet
    expect(base45Decode('ZZZ')).toBeNull(); // overflows 16 bits
  });
});

describe('packet', () => {
  it('round-trips', () => {
    const payload = randomBytes(200, 42);
    const encoded = encodePacket({ streamId: 4242, totalBytes: 98765, chunkSize: 200, seed: 0xdeadbeef, payload });
    const decoded = decodePacket(encoded)!;
    expect(decoded).not.toBeNull();
    expect(decoded.streamId).toBe(4242);
    expect(decoded.totalBytes).toBe(98765);
    expect(decoded.chunkSize).toBe(200);
    expect(decoded.seed).toBe(0xdeadbeef);
    expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
  });

  it('rejects noise', () => {
    expect(decodePacket(new Uint8Array(0))).toBeNull();
    expect(decodePacket(randomBytes(50, 3))).toBeNull(); // wrong magic
    const truncated = encodePacket({ streamId: 1, totalBytes: 100, chunkSize: 200, seed: 1, payload: randomBytes(200) });
    expect(decodePacket(truncated.subarray(0, 50))).toBeNull();
  });
});

describe('fountain', () => {
  it('derives the same chunk selection on both ends from the seed alone', () => {
    for (const seed of [0, 1, 12345, 0xffffffff]) {
      expect(pickIndices(seed, 100)).toEqual(pickIndices(seed, 100));
    }
  });

  it('only ever selects valid, distinct chunk indices', () => {
    for (let seed = 0; seed < 400; seed++) {
      const indices = pickIndices(seed, 64);
      expect(indices.length).toBeGreaterThan(0);
      expect(new Set(indices).size).toBe(indices.length);
      for (const i of indices) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(64);
      }
    }
  });

  it('reconstructs a file from a lossless drop stream', () => {
    const data = randomBytes(7000, 11);
    const encoder = new FountainEncoder(data, 200, 1000);
    const decoder = new FountainDecoder(data.length, 200);

    let drops = 0;
    while (!decoder.isComplete && drops < 5000) {
      const { seed, payload } = encoder.next();
      decoder.addDrop(seed, payload);
      drops++;
    }

    expect(decoder.isComplete).toBe(true);
    expect(Array.from(decoder.getData()!)).toEqual(Array.from(data));
    // Started mid-stream (seed 1000), so this is the plain coded overhead.
    expect(drops).toBeLessThan(encoder.chunkCount * 1.8);
  });

  it('costs almost nothing when the receiver is watching from the first frame', () => {
    const data = randomBytes(9000, 17);
    const encoder = new FountainEncoder(data, 180); // default seed 0: systematic pass
    const decoder = new FountainDecoder(data.length, 180);

    let drops = 0;
    while (!decoder.isComplete && drops < 5000) {
      const { seed, payload } = encoder.next();
      decoder.addDrop(seed, payload);
      drops++;
    }

    expect(Array.from(decoder.getData()!)).toEqual(Array.from(data));
    // The systematic first pass is exactly the file, so this should be the chunk count.
    expect(drops).toBe(encoder.chunkCount);
  });

  it('emits the plain chunks first, so a drop is readable without any decoding', () => {
    const data = randomBytes(1000, 23);
    const encoder = new FountainEncoder(data, 250);
    for (let i = 0; i < encoder.chunkCount; i++) {
      const { seed, payload } = encoder.next();
      expect(seed).toBe(i);
      expect(Array.from(payload.subarray(0, 250))).toEqual(Array.from(data.subarray(i * 250, (i + 1) * 250)));
    }
  });

  it('survives heavy frame loss, which is the whole point', () => {
    const data = randomBytes(20000, 5);
    const encoder = new FountainEncoder(data, 256, 77);
    const decoder = new FountainDecoder(data.length, 256);
    const rand = mulberry32(999);

    let emitted = 0;
    while (!decoder.isComplete && emitted < 40000) {
      const { seed, payload } = encoder.next();
      emitted++;
      if (rand() < 0.6) continue; // 60% of frames never make it past the camera
      decoder.addDrop(seed, payload);
    }

    expect(decoder.isComplete).toBe(true);
    expect(Array.from(decoder.getData()!)).toEqual(Array.from(data));
  });

  it('lets a receiver join a transfer already in progress', () => {
    const data = randomBytes(9000, 21);
    const encoder = new FountainEncoder(data, 220, 3);
    for (let i = 0; i < 500; i++) encoder.next(); // sender has been looping for a while

    const decoder = new FountainDecoder(data.length, 220);
    let drops = 0;
    while (!decoder.isComplete && drops < 5000) {
      const { seed, payload } = encoder.next();
      decoder.addDrop(seed, payload);
      drops++;
    }
    expect(decoder.isComplete).toBe(true);
    expect(Array.from(decoder.getData()!)).toEqual(Array.from(data));
  });

  it('ignores duplicate drops rather than double-counting them', () => {
    const data = randomBytes(2000, 8);
    const encoder = new FountainEncoder(data, 100, 50);
    const decoder = new FountainDecoder(data.length, 100);
    const drop = encoder.next();
    for (let i = 0; i < 50; i++) decoder.addDrop(drop.seed, drop.payload);
    expect(decoder.recoveredCount).toBeLessThanOrEqual(decoder.chunkCount);
  });

  it('handles a payload that fits in a single chunk', () => {
    const data = randomBytes(40, 2);
    const encoder = new FountainEncoder(data, 256, 4);
    const decoder = new FountainDecoder(data.length, 256);
    while (!decoder.isComplete) {
      const { seed, payload } = encoder.next();
      decoder.addDrop(seed, payload);
    }
    expect(Array.from(decoder.getData()!)).toEqual(Array.from(data));
  });
});

describe('envelope', () => {
  it('round-trips text and verifies the checksum', async () => {
    const payload = payloadFromText('Grüße von Light Spark! 🔦 Über Licht übertragen.');
    const envelope = await buildEnvelope(payload);
    const parsed = await parseEnvelope(envelope);

    expect(parsed).not.toBeNull();
    expect(parsed!.verified).toBe(true);
    expect(parsed!.name).toBe('nachricht.txt');
    expect(new TextDecoder().decode(parsed!.data)).toBe('Grüße von Light Spark! 🔦 Über Licht übertragen.');
  });

  it('round-trips binary through the full fountain path', async () => {
    const data = randomBytes(30000, 33);
    const envelope = await buildEnvelope({ name: 'bild.png', mime: 'image/png', data });

    const encoder = new FountainEncoder(envelope, 300, 12);
    const decoder = new FountainDecoder(envelope.length, 300);
    while (!decoder.isComplete) {
      const { seed, payload } = encoder.next();
      decoder.addDrop(seed, payload);
    }

    const parsed = await parseEnvelope(decoder.getData()!);
    expect(parsed!.verified).toBe(true);
    expect(parsed!.name).toBe('bild.png');
    expect(parsed!.mime).toBe('image/png');
    expect(Array.from(parsed!.data)).toEqual(Array.from(data));
  });

  it('compresses repetitive data but leaves incompressible data alone', async () => {
    const repetitive = new TextEncoder().encode('Light Spark! '.repeat(500));
    const noise = randomBytes(repetitive.length, 4);
    const compressed = await buildEnvelope({ name: 'a.txt', mime: 'text/plain', data: repetitive });
    const uncompressed = await buildEnvelope({ name: 'a.bin', mime: 'application/octet-stream', data: noise });

    expect(compressed.length).toBeLessThan(repetitive.length / 4);
    expect(uncompressed.length).toBeLessThan(noise.length + 100);
  });

  it('flags corruption instead of handing back bad data', async () => {
    const envelope = await buildEnvelope({ name: 'x.bin', mime: 'application/octet-stream', data: randomBytes(500, 6) });
    envelope[envelope.length - 10] ^= 0xff;
    const parsed = await parseEnvelope(envelope);
    expect(parsed!.verified).toBe(false);
  });

  it('rejects bytes that are not an envelope at all', async () => {
    expect(await parseEnvelope(randomBytes(100, 9))).toBeNull();
    expect(await parseEnvelope(new Uint8Array(3))).toBeNull();
  });
});
