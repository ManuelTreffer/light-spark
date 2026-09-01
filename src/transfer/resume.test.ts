import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../core/rng';
import { SenderSession } from './senderSession';
import { ReceiverSession } from './receiverSession';
import { createBlockPlan } from './blockPlan';
import { IndexedDbTransferRepository } from '../storage/indexedDbTransferRepository';
import { StorageUnavailableError, type TransferRepository, type PersistedReceiveState, type StoredTransferSummary } from '../storage/types';
import { generateTransferId, transferIdToHex } from '../protocol/transferId';
import type { ManifestPayload, TransferManifest } from '../protocol/types';

let dbCounter = 0;
function newRepository(): IndexedDbTransferRepository {
  dbCounter += 1;
  return new IndexedDbTransferRepository(`resume-test-db-${dbCounter}`);
}

function randomBytes(n: number, seed: number): Uint8Array {
  const rand = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

function buildManifest(data: Uint8Array, blockSize: number, sourceChunkSize: number, overrides: Partial<ManifestPayload> = {}): ManifestPayload {
  const plan = createBlockPlan(data.length, blockSize);
  return {
    fileName: 'resume-test.bin',
    mimeType: 'application/octet-stream',
    originalSize: data.length,
    encodedSize: data.length,
    blockSize,
    blockCount: plan.blockCount,
    sourceChunkSize,
    compression: 'none',
    fileHashAlgorithm: 'sha256',
    fileHash: new Uint8Array(32),
    ...overrides,
  };
}

async function feedAll(receiver: ReceiverSession, frames: readonly Uint8Array[]): Promise<void> {
  for (const frame of frames) await receiver.ingestFrame(frame);
}

describe('Resume (Milestone 4.3): a fresh ReceiverSession picks up verified blocks from storage', () => {
  it('an already-verified block is reported "verified" immediately on the manifest alone, with no Data frames for it', async () => {
    const data = randomBytes(4000, 1); // 4 blocks of 1000
    const manifest = buildManifest(data, 1000, 150);
    const transferId = generateTransferId();
    const repository = newRepository();

    // First "session": receive the whole transfer normally, with persistence on.
    const sender = new SenderSession({ transferId, manifest, data });
    const first = new ReceiverSession({ repository });
    const frames: Uint8Array[] = [];
    for (let i = 0; i < 2000; i++) frames.push(sender.next());
    await feedAll(first, frames);
    expect(first.state.status).toBe('completed');
    expect(first.getAssembledData()).toEqual(data);

    // "Reload": a brand new ReceiverSession, same repository, nothing shared
    // with `first` except what actually made it into storage. Feed it only
    // the manifest — no Data frames at all.
    const second = new ReceiverSession({ repository });
    const freshSender = new SenderSession({ transferId, manifest, data });
    await second.ingestFrame(freshSender.next()); // the first frame is always the manifest

    expect(second.state.resumed).toBe(true);
    expect(second.state.blocks.every((b) => b.status === 'verified')).toBe(true);
    expect(second.getAssembledData()).toEqual(data);
  });

  it('a partially-received transfer resumes only the missing blocks, not re-decoding the rest', async () => {
    const data = randomBytes(4000, 2);
    const manifest = buildManifest(data, 1000, 150);
    const transferId = generateTransferId();
    const repository = newRepository();

    // First session gets far enough to fully verify block 0 (and only block
    // 0 — send just past its systematic pass, then stop).
    const sender = new SenderSession({ transferId, manifest, data, blockCompleteEveryNFrames: 4 });
    const first = new ReceiverSession({ repository });
    const earlyFrames: Uint8Array[] = [];
    for (let i = 0; i < 20; i++) earlyFrames.push(sender.next());
    await feedAll(first, earlyFrames);
    expect(first.state.blocks[0].status).toBe('verified');
    expect(first.state.blocks[1].status).not.toBe('verified');

    // "Reload" with a fresh sender/session pair for the same transfer.
    const second = new ReceiverSession({ repository });
    const freshSender = new SenderSession({ transferId, manifest, data });
    await second.ingestFrame(freshSender.next()); // manifest

    expect(second.state.resumed).toBe(true);
    expect(second.state.blocks[0].status).toBe('verified'); // resumed from storage
    expect(second.state.blocks[1].status).toBe('missing'); // genuinely not received yet

    // Finish the transfer on the resumed session.
    const rest: Uint8Array[] = [];
    for (let i = 0; i < 2000; i++) rest.push(freshSender.next());
    await feedAll(second, rest);
    expect(second.getAssembledData()).toEqual(data);
  });

  it('two different transfers can be stored and resumed independently', async () => {
    const repository = newRepository();
    const dataA = randomBytes(1200, 10);
    const dataB = randomBytes(1200, 11);
    const manifestA = buildManifest(dataA, 1200, 150);
    const manifestB = buildManifest(dataB, 1200, 150);
    const idA = generateTransferId();
    const idB = generateTransferId();

    const senderA = new SenderSession({ transferId: idA, manifest: manifestA, data: dataA });
    const receiverA = new ReceiverSession({ repository });
    const framesA: Uint8Array[] = [];
    for (let i = 0; i < 40; i++) framesA.push(senderA.next());
    await feedAll(receiverA, framesA);
    expect(receiverA.state.status).toBe('completed');

    const senderB = new SenderSession({ transferId: idB, manifest: manifestB, data: dataB });
    const receiverB = new ReceiverSession({ repository });
    const framesB: Uint8Array[] = [];
    for (let i = 0; i < 40; i++) framesB.push(senderB.next());
    await feedAll(receiverB, framesB);
    expect(receiverB.state.status).toBe('completed');

    const summaries = await repository.listTransfers();
    expect(summaries).toHaveLength(2);
    const names = summaries.map((s) => s.transferId).sort();
    expect(names).toEqual([transferIdToHex(idA), transferIdToHex(idB)].sort());
    expect(summaries.every((s: StoredTransferSummary) => s.status === 'completed')).toBe(true);
  });

  it('the user can delete a stored transfer', async () => {
    const repository = newRepository();
    const data = randomBytes(1200, 12);
    const manifest = buildManifest(data, 1200, 150);
    const transferId = generateTransferId();
    const sender = new SenderSession({ transferId, manifest, data });
    const receiver = new ReceiverSession({ repository });
    const frames: Uint8Array[] = [];
    for (let i = 0; i < 40; i++) frames.push(sender.next());
    await feedAll(receiver, frames);

    expect(await repository.listTransfers()).toHaveLength(1);
    await repository.deleteTransfer(transferIdToHex(transferId));
    expect(await repository.listTransfers()).toHaveLength(0);

    // A "reload" after deletion finds nothing to resume — receives fresh.
    const freshReceiver = new ReceiverSession({ repository });
    const freshSender = new SenderSession({ transferId, manifest, data });
    await freshReceiver.ingestFrame(freshSender.next());
    expect(freshReceiver.state.resumed).toBe(false);
  });
});

describe('Manifest conflicts (Milestone 4.4)', () => {
  it('a differing manifest for a transferId already in storage is rejected, never overwriting stored data', async () => {
    const repository = newRepository();
    const originalData = randomBytes(1200, 20);
    const originalManifest = buildManifest(originalData, 1200, 150);
    const transferId = generateTransferId();

    const sender = new SenderSession({ transferId, manifest: originalManifest, data: originalData });
    const first = new ReceiverSession({ repository });
    const frames: Uint8Array[] = [];
    for (let i = 0; i < 40; i++) frames.push(sender.next());
    await feedAll(first, frames);
    expect(first.state.status).toBe('completed');

    // A conflicting manifest for the SAME transferId — different file
    // entirely (a colliding random ID, or a corrupted resend; either way
    // the receiver can't tell, and must not guess).
    const conflictingData = randomBytes(900, 21);
    const conflictingManifest = buildManifest(conflictingData, 900, 150, { fileName: 'different-file.bin' });

    const second = new ReceiverSession({ repository });
    const conflictHeader = { transferId, manifest: conflictingManifest, data: conflictingData };
    const conflictSender = new SenderSession(conflictHeader);
    await second.ingestFrame(conflictSender.next()); // manifest frame

    expect(second.state.status).toBe('failed');
    expect(second.state.failureReason).toContain('Conflicting manifest');

    // The originally stored manifest is untouched.
    const stillStored = await repository.loadManifest(transferIdToHex(transferId));
    expect(stillStored?.fileName).toBe('resume-test.bin');
    expect(stillStored?.encodedSize).toBe(originalData.length);
  });
});

describe('Storage failures (Milestone 4.5): reported clearly, never fatal to the current session', () => {
  class AlwaysFailingRepository implements TransferRepository {
    private fail(): Promise<never> {
      return Promise.reject(new StorageUnavailableError('simulated storage failure', 'unknown'));
    }
    saveManifest(_manifest: TransferManifest): Promise<void> {
      return this.fail();
    }
    loadManifest(_transferId: string): Promise<TransferManifest | null> {
      return this.fail();
    }
    saveBlock(_transferId: string, _blockIndex: number, _data: Uint8Array): Promise<void> {
      return this.fail();
    }
    loadBlock(_transferId: string, _blockIndex: number): Promise<Uint8Array | null> {
      return this.fail();
    }
    saveReceiveState(_state: PersistedReceiveState): Promise<void> {
      return this.fail();
    }
    loadReceiveState(_transferId: string): Promise<PersistedReceiveState | null> {
      return this.fail();
    }
    listTransfers(): Promise<StoredTransferSummary[]> {
      return this.fail();
    }
    deleteTransfer(_transferId: string): Promise<void> {
      return this.fail();
    }
  }

  it('a transfer still completes in-memory even when every storage call fails', async () => {
    const data = randomBytes(1200, 40);
    const manifest = buildManifest(data, 1200, 150);
    const transferId = generateTransferId();
    const sender = new SenderSession({ transferId, manifest, data });
    const receiver = new ReceiverSession({ repository: new AlwaysFailingRepository() });

    const frames: Uint8Array[] = [];
    for (let i = 0; i < 40; i++) frames.push(sender.next());

    // None of this should throw, despite every storage call rejecting.
    await feedAll(receiver, frames);

    expect(receiver.getAssembledData()).toEqual(data);
    expect(receiver.state.failureReason).toContain('Storage error');
    // The transfer itself is not reported as failed just because persistence
    // is broken — receiving and reconstruction are unaffected. failureReason
    // is diagnostic, not the same thing as SessionStatus here: a resumed-vs-
    // not distinction still resolves 'completed' once every block verifies.
    expect(receiver.state.status).toBe('completed');
  });
});
