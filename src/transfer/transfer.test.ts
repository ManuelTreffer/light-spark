import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../core/rng';
import { crc32 } from '../core/crc32';
import { SenderSession } from './senderSession';
import { ReceiverSession } from './receiverSession';
import { createBlockPlan } from './blockPlan';
import { simulateChannel, NO_FAULTS, type ChannelFaultModel } from './faultModel';
import { encodeCommonFrameHeader, encodeDataFrameHeader } from '../protocol/frameHeader';
import { encodeManifest } from '../protocol/manifest';
import { FrameType, PROTOCOL_VERSION, type ManifestPayload } from '../protocol/types';
import { generateTransferId } from '../protocol/transferId';

function randomBytes(n: number, seed: number): Uint8Array {
  const rand = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

function buildManifest(data: Uint8Array, blockSize: number, sourceChunkSize: number, overrides: Partial<ManifestPayload> = {}): ManifestPayload {
  const plan = createBlockPlan(data.length, blockSize);
  return {
    fileName: 'test.bin',
    mimeType: 'application/octet-stream',
    originalSize: data.length,
    encodedSize: data.length,
    blockSize,
    blockCount: plan.blockCount,
    sourceChunkSize,
    compression: 'none',
    fileHashAlgorithm: 'sha256',
    fileHash: new Uint8Array(32), // not yet verified in PR 2 — see ReceiverSession's doc comment
    ...overrides,
  };
}

/** Drives `count` frames from a fresh SenderSession through a fault model
 * into a fresh ReceiverSession, and returns the receiver once done. */
function runTransfer(
  data: Uint8Array,
  blockSize: number,
  sourceChunkSize: number,
  frameCount: number,
  faults: ChannelFaultModel,
  seed: number,
): ReceiverSession {
  const manifest = buildManifest(data, blockSize, sourceChunkSize);
  const transferId = generateTransferId();
  const sender = new SenderSession({ transferId, manifest, data });

  const frames: Uint8Array[] = [];
  for (let i = 0; i < frameCount; i++) frames.push(sender.next());

  const delivered = simulateChannel(frames, faults, seed);

  const receiver = new ReceiverSession();
  for (const frame of delivered) receiver.ingestFrame(frame);
  return receiver;
}

describe('SenderSession + ReceiverSession — reconstruction', () => {
  it('reconstructs a multi-block file with no channel faults', () => {
    const data = randomBytes(9000, 1); // several blocks at blockSize=2000
    const receiver = runTransfer(data, 2000, 180, 400, NO_FAULTS, 1);
    expect(receiver.state.status).toBe('completed');
    expect(receiver.getAssembledData()).toEqual(data);
  });

  it('reconstructs despite dropped frames', () => {
    const data = randomBytes(6000, 2);
    const faults: ChannelFaultModel = { frameDropRate: 0.3, frameDuplicateRate: 0, frameCorruptionRate: 0, frameReorderWindow: 0 };
    const receiver = runTransfer(data, 1500, 150, 1200, faults, 42);
    expect(receiver.getAssembledData()).toEqual(data);
  });

  it('reconstructs despite reordered frames — block order does not matter', () => {
    const data = randomBytes(6000, 3);
    const faults: ChannelFaultModel = { frameDropRate: 0, frameDuplicateRate: 0, frameCorruptionRate: 0, frameReorderWindow: 25 };
    const receiver = runTransfer(data, 1500, 150, 500, faults, 7);
    expect(receiver.getAssembledData()).toEqual(data);
  });

  it('duplicate frames do not change the result', () => {
    const data = randomBytes(4000, 4);
    const faults: ChannelFaultModel = { frameDropRate: 0, frameDuplicateRate: 0.5, frameCorruptionRate: 0, frameReorderWindow: 0 };
    const receiver = runTransfer(data, 1000, 150, 400, faults, 11);
    expect(receiver.getAssembledData()).toEqual(data);
    // The dedup path (entry.seenSeeds) must actually have fired, not just
    // "happened to still work" — otherwise this test wouldn't be exercising
    // what it claims to.
    expect(receiver.state.duplicateFrames).toBeGreaterThan(0);
  });

  it('reconstructs under combined loss, duplication, corruption, and reordering', () => {
    const data = randomBytes(12000, 5);
    const faults: ChannelFaultModel = { frameDropRate: 0.25, frameDuplicateRate: 0.15, frameCorruptionRate: 0.05, frameReorderWindow: 10 };
    const receiver = runTransfer(data, 3000, 200, 3000, faults, 99);
    expect(receiver.getAssembledData()).toEqual(data);
  });

  it('a receiver joining mid-stream still completes (systematic pass repeats via block cycling)', () => {
    const data = randomBytes(6000, 6);
    const manifest = buildManifest(data, 1500, 150);
    const transferId = generateTransferId();
    const sender = new SenderSession({ transferId, manifest, data });

    const allFrames: Uint8Array[] = [];
    for (let i = 0; i < 1200; i++) allFrames.push(sender.next());

    // Drop the first half entirely — as if the receiver only started
    // watching partway through the stream.
    const lateFrames = allFrames.slice(allFrames.length / 2);

    const receiver = new ReceiverSession();
    for (const frame of lateFrames) receiver.ingestFrame(frame);
    expect(receiver.getAssembledData()).toEqual(data);
  });
});

describe('Block boundary edge cases (Milestone 2.6)', () => {
  it('an empty (0-byte) file is one block of length 0', () => {
    const data = new Uint8Array(0);
    const receiver = runTransfer(data, 1000, 100, 50, NO_FAULTS, 20);
    expect(receiver.state.blocks.length).toBe(1);
    expect(receiver.getAssembledData()).toEqual(data);
  });

  it('a 1-byte file', () => {
    const data = new Uint8Array([42]);
    const receiver = runTransfer(data, 1000, 100, 50, NO_FAULTS, 21);
    expect(receiver.getAssembledData()).toEqual(data);
  });

  it('data length exactly on a source-chunk boundary', () => {
    const data = randomBytes(300, 22); // exactly 2 chunks of 150
    const receiver = runTransfer(data, 1000, 150, 100, NO_FAULTS, 22);
    expect(receiver.getAssembledData()).toEqual(data);
  });

  it('data length exactly on a block boundary (multiple whole blocks, no short tail)', () => {
    const data = randomBytes(4000, 23); // exactly 4 blocks of 1000
    const plan = createBlockPlan(data.length, 1000);
    expect(plan.blockCount).toBe(4);
    expect(plan.getBlockRange(3).length).toBe(1000); // last block is NOT short here
    const receiver = runTransfer(data, 1000, 150, 800, NO_FAULTS, 23);
    expect(receiver.getAssembledData()).toEqual(data);
  });

  it('a short final block (not a multiple of blockSize)', () => {
    const data = randomBytes(3300, 24); // 4 blocks of 1000, last one 300 bytes
    const plan = createBlockPlan(data.length, 1000);
    expect(plan.blockCount).toBe(4);
    expect(plan.getBlockRange(3).length).toBe(300);
    const receiver = runTransfer(data, 1000, 150, 800, NO_FAULTS, 24);
    expect(receiver.getAssembledData()).toEqual(data);
  });

  it('BlockPlan rejects a non-positive blockSize and out-of-range indices', () => {
    expect(() => createBlockPlan(100, 0)).toThrow();
    expect(() => createBlockPlan(100, -1)).toThrow();
    const plan = createBlockPlan(100, 10);
    expect(() => plan.getBlockRange(-1)).toThrow();
    expect(() => plan.getBlockRange(plan.blockCount)).toThrow();
  });
});

describe('Block integrity — a corrupted block is never marked verified', () => {
  it('rejects a block whose reconstructed bytes do not match the announced CRC', () => {
    const data = randomBytes(1200, 30);
    const manifest = buildManifest(data, 1200, 150); // single block
    const transferId = generateTransferId();

    // Send the real data frames, but announce a CRC for *different* bytes —
    // simulating a corrupted-but-plausible drop having poisoned the graph
    // (see docs/architecture-audit.md risk #6): the receiver ends up with
    // *some* value that isn't the sender's true block.
    const sender = new SenderSession({ transferId, manifest, data, blockCompleteEveryNFrames: 5 });
    const receiver = new ReceiverSession();

    const wrongCrc = crc32(randomBytes(1200, 999)); // definitely not this block's real CRC

    for (let i = 0; i < 30; i++) {
      const frame = sender.next();
      // Intercept and corrupt only BlockComplete frames' payload so every
      // announcement claims the wrong CRC, while the Data frames (and thus
      // the actual reconstructed bytes) stay perfectly intact.
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      if (frame[3] === FrameType.BlockComplete) {
        view.setUint32(27 + 4, wrongCrc, false); // CommonFrameHeader is 27 bytes; blockCrc32 is payload offset 4
      }
      receiver.ingestFrame(frame);
    }

    const block = receiver.state.blocks[0];
    expect(block.status).not.toBe('verified');
    expect(receiver.getAssembledData()).toBeNull();
  });

  it('recovers once a correct BlockComplete frame arrives (no permanent poisoning)', () => {
    const data = randomBytes(1200, 31); // exactly 8 chunks of 150 — systematic pass alone completes it
    const manifest = buildManifest(data, 1200, 150);
    const transferId = generateTransferId();
    // Cadences kept comfortably above the 8-frame systematic pass, so — after
    // the mandatory first-frame manifest — the next 8 next() calls are pure
    // Data frames, and no BlockComplete has had a chance to arrive yet when
    // the block finishes decoding.
    const sender = new SenderSession({ transferId, manifest, data, manifestEveryNFrames: 100, blockCompleteEveryNFrames: 15 });
    const receiver = new ReceiverSession();

    for (let i = 0; i < 9; i++) receiver.ingestFrame(sender.next()); // 1 manifest + 8 data (seeds 0-7)
    expect(receiver.state.blocks[0].status).toBe('decoded'); // solved, not yet verified

    // Now let the stream continue — a real BlockComplete follows within this span.
    for (let i = 0; i < 20; i++) receiver.ingestFrame(sender.next());
    expect(receiver.state.blocks[0].status).toBe('verified');
    expect(receiver.getAssembledData()).toEqual(data);
  });
});

describe('Memory bound — active block decoders (Milestone 2.4)', () => {
  it('never keeps more than maxActiveBlockDecoders blocks in the "receiving" state at once', () => {
    const sourceChunkSize = 100;
    const blockSize = 1000; // 10 chunks/block
    const totalBlocks = 8;
    const manifest = buildManifest(new Uint8Array(blockSize * totalBlocks), blockSize, sourceChunkSize, {
      encodedSize: blockSize * totalBlocks,
      originalSize: blockSize * totalBlocks,
    });
    const transferId = generateTransferId();
    const maxActive = 3;
    const receiver = new ReceiverSession({ maxActiveBlockDecoders: maxActive });

    // Manifest first, built directly (not via SenderSession) to keep this
    // test focused on eviction behaviour rather than its send cadence.
    const manifestHeader = encodeCommonFrameHeader({
      protocolVersion: PROTOCOL_VERSION,
      frameType: FrameType.Manifest,
      flags: 0,
      transferId,
      sequenceNumber: 0,
      payloadLength: encodeManifest(manifest).length,
    });
    const manifestPayload = encodeManifest(manifest);
    const manifestBytes = new Uint8Array(manifestHeader.length + manifestPayload.length);
    manifestBytes.set(manifestHeader, 0);
    manifestBytes.set(manifestPayload, manifestHeader.length);
    receiver.ingestFrame(manifestBytes);

    // Now feed exactly one (non-completing, non-systematic) drop for every
    // block, round and round, without ever sending enough for any block to
    // finish — an adversarial-ish interleaving that would blow up memory
    // without an eviction bound.
    for (let round = 0; round < 5; round++) {
      for (let blockIndex = 0; blockIndex < totalBlocks; blockIndex++) {
        const seed = sourceChunkSize + round; // >= chunk count, so combinatorial (never a lone systematic solve)
        const dataHeader = encodeDataFrameHeader({ blockIndex, blockSourceChunkCount: sourceChunkSize / 10, dropletSeed: seed, dropletDegree: 2 });
        const dropPayload = new Uint8Array(sourceChunkSize).fill(1);
        const payload = new Uint8Array(dataHeader.length + dropPayload.length);
        payload.set(dataHeader, 0);
        payload.set(dropPayload, dataHeader.length);
        const header = encodeCommonFrameHeader({
          protocolVersion: PROTOCOL_VERSION,
          frameType: FrameType.Data,
          flags: 0,
          transferId,
          sequenceNumber: round * totalBlocks + blockIndex + 1,
          payloadLength: payload.length,
        });
        const frame = new Uint8Array(header.length + payload.length);
        frame.set(header, 0);
        frame.set(payload, header.length);
        receiver.ingestFrame(frame);

        const receivingCount = receiver.state.blocks.filter((b) => b.status === 'receiving').length;
        expect(receivingCount).toBeLessThanOrEqual(maxActive);
      }
    }
  });
});
