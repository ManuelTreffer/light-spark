import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { IndexedDbTransferRepository, isIndexedDbSupported } from './indexedDbTransferRepository';
import { StorageUnavailableError, type PersistedReceiveState } from './types';
import { generateTransferId, transferIdToHex } from '../protocol/transferId';
import type { TransferManifest } from '../protocol/types';

// Every test gets its own database name, so tests never interfere with each
// other and there's no need to delete/reset a shared database between runs
// (indexedDB.deleteDatabase() blocks until every open connection closes,
// which is more test-plumbing than this needs).
let dbCounter = 0;
function newRepository(): IndexedDbTransferRepository {
  dbCounter += 1;
  return new IndexedDbTransferRepository(`test-db-${dbCounter}`);
}

function makeManifest(overrides: Partial<TransferManifest> = {}): TransferManifest {
  return {
    protocolVersion: 2,
    transferId: generateTransferId(),
    fileName: 'urlaubsfoto.jpg',
    mimeType: 'image/jpeg',
    originalSize: 4000,
    encodedSize: 4000,
    blockSize: 1000,
    blockCount: 4,
    sourceChunkSize: 150,
    compression: 'none',
    fileHashAlgorithm: 'sha256',
    fileHash: new Uint8Array(32),
    ...overrides,
  };
}

describe('IndexedDbTransferRepository', () => {
  it('saves and loads a manifest, byte-for-byte', async () => {
    const repo = newRepository();
    const manifest = makeManifest();
    await repo.saveManifest(manifest);

    const loaded = await repo.loadManifest(transferIdToHex(manifest.transferId));
    expect(loaded).toEqual(manifest);
  });

  it('returns null for a transfer that was never saved', async () => {
    const repo = newRepository();
    expect(await repo.loadManifest('00'.repeat(16))).toBeNull();
    expect(await repo.loadBlock('00'.repeat(16), 0)).toBeNull();
    expect(await repo.loadReceiveState('00'.repeat(16))).toBeNull();
  });

  it('saves and loads blocks independently, keyed by transferId + blockIndex', async () => {
    const repo = newRepository();
    const idA = transferIdToHex(generateTransferId());
    const idB = transferIdToHex(generateTransferId());

    await repo.saveBlock(idA, 0, new Uint8Array([1, 2, 3]));
    await repo.saveBlock(idA, 1, new Uint8Array([4, 5, 6]));
    await repo.saveBlock(idB, 0, new Uint8Array([9, 9, 9])); // same blockIndex, different transfer

    expect(await repo.loadBlock(idA, 0)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await repo.loadBlock(idA, 1)).toEqual(new Uint8Array([4, 5, 6]));
    expect(await repo.loadBlock(idB, 0)).toEqual(new Uint8Array([9, 9, 9]));
    expect(await repo.loadBlock(idA, 2)).toBeNull();
  });

  it('overwrites a block saved twice under the same key', async () => {
    const repo = newRepository();
    const id = transferIdToHex(generateTransferId());
    await repo.saveBlock(id, 0, new Uint8Array([1]));
    await repo.saveBlock(id, 0, new Uint8Array([2]));
    expect(await repo.loadBlock(id, 0)).toEqual(new Uint8Array([2]));
  });

  it('saves and loads receive state', async () => {
    const repo = newRepository();
    const state: PersistedReceiveState = {
      transferId: transferIdToHex(generateTransferId()),
      protocolVersion: 2,
      verifiedBlockIndices: [0, 2, 3],
      totalBytes: 4000,
      receivedBytes: 3000,
      lastUpdatedAt: 1_700_000_000_000,
    };
    await repo.saveReceiveState(state);
    expect(await repo.loadReceiveState(state.transferId)).toEqual(state);
  });

  it('lists multiple transfers with correct progress and status', async () => {
    const repo = newRepository();

    const inProgress = makeManifest({ fileName: 'a.bin', blockCount: 4, encodedSize: 4000 });
    const complete = makeManifest({ fileName: 'b.bin', blockCount: 2, encodedSize: 2000 });

    await repo.saveManifest(inProgress);
    await repo.saveManifest(complete);
    await repo.saveReceiveState({
      transferId: transferIdToHex(inProgress.transferId),
      protocolVersion: 2,
      verifiedBlockIndices: [0, 1],
      totalBytes: 4000,
      receivedBytes: 2000,
      lastUpdatedAt: 100,
    });
    await repo.saveReceiveState({
      transferId: transferIdToHex(complete.transferId),
      protocolVersion: 2,
      verifiedBlockIndices: [0, 1],
      totalBytes: 2000,
      receivedBytes: 2000,
      lastUpdatedAt: 200,
    });

    const summaries = await repo.listTransfers();
    expect(summaries).toHaveLength(2);

    const a = summaries.find((s) => s.fileName === 'a.bin')!;
    expect(a.progress).toBe(0.5);
    expect(a.status).toBe('receiving');

    const b = summaries.find((s) => s.fileName === 'b.bin')!;
    expect(b.progress).toBe(1);
    expect(b.status).toBe('completed');
  });

  it('a manifest with no receive state yet is reported as receiving, 0 progress', async () => {
    const repo = newRepository();
    const manifest = makeManifest();
    await repo.saveManifest(manifest);

    const [summary] = await repo.listTransfers();
    expect(summary.status).toBe('receiving');
    expect(summary.progress).toBe(0);
  });

  it('deleteTransfer removes the manifest, receive state, and every block for that transfer only', async () => {
    const repo = newRepository();
    const target = makeManifest();
    const other = makeManifest();
    const targetId = transferIdToHex(target.transferId);
    const otherId = transferIdToHex(other.transferId);

    await repo.saveManifest(target);
    await repo.saveManifest(other);
    await repo.saveBlock(targetId, 0, new Uint8Array([1]));
    await repo.saveBlock(targetId, 1, new Uint8Array([2]));
    await repo.saveBlock(otherId, 0, new Uint8Array([3]));
    await repo.saveReceiveState({
      transferId: targetId,
      protocolVersion: 2,
      verifiedBlockIndices: [0, 1],
      totalBytes: 4000,
      receivedBytes: 4000,
      lastUpdatedAt: 1,
    });

    await repo.deleteTransfer(targetId);

    expect(await repo.loadManifest(targetId)).toBeNull();
    expect(await repo.loadReceiveState(targetId)).toBeNull();
    expect(await repo.loadBlock(targetId, 0)).toBeNull();
    expect(await repo.loadBlock(targetId, 1)).toBeNull();

    // The other transfer is untouched.
    expect(await repo.loadManifest(otherId)).not.toBeNull();
    expect(await repo.loadBlock(otherId, 0)).toEqual(new Uint8Array([3]));
  });

  it('surviving a "reload": a second repository instance sees what the first one saved', async () => {
    // Same underlying database name for both, unlike newRepository()'s
    // usual per-test isolation — this test is specifically about two
    // independent instances sharing that one database, the way a page
    // reload would construct a brand new IndexedDbTransferRepository
    // against the same persistent browser-side database.
    const dbName = 'test-db-reload';
    const first = new IndexedDbTransferRepository(dbName);
    const manifest = makeManifest();
    const id = transferIdToHex(manifest.transferId);
    await first.saveManifest(manifest);
    await first.saveBlock(id, 0, new Uint8Array([7, 7, 7]));
    await first.close();

    const second = new IndexedDbTransferRepository(dbName);
    expect(await second.loadManifest(id)).toEqual(manifest);
    expect(await second.loadBlock(id, 0)).toEqual(new Uint8Array([7, 7, 7]));
  });
});

describe('IndexedDB unavailable', () => {
  it('isIndexedDbSupported reflects the global', () => {
    expect(isIndexedDbSupported()).toBe(true);
  });

  it('surfaces a StorageUnavailableError, not a raw exception, when indexedDB is missing', async () => {
    const real = globalThis.indexedDB;
    // @ts-expect-error — deliberately simulating an environment without IndexedDB (e.g. some private-browsing modes).
    delete globalThis.indexedDB;
    try {
      expect(isIndexedDbSupported()).toBe(false);
      const repo = newRepository();
      await expect(repo.saveManifest(makeManifest())).rejects.toThrow(StorageUnavailableError);
      await expect(repo.saveManifest(makeManifest())).rejects.toMatchObject({ reason: 'unsupported' });
    } finally {
      globalThis.indexedDB = real;
    }
  });
});
