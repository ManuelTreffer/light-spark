import { transferIdFromHex, transferIdToHex } from '../protocol/transferId';
import type { CompressionAlgorithm, HashAlgorithm, TransferManifest } from '../protocol/types';
import { StorageUnavailableError, type PersistedReceiveState, type StoredTransferSummary, type TransferRepository } from './types';

/**
 * IndexedDB-backed `TransferRepository` (Milestone 4.1). This is the only
 * file in `storage/` that touches the actual browser API — everything else
 * (including `transfer/receiverSession.ts`) depends only on the
 * `TransferRepository` interface in `types.ts`.
 *
 * Schema (version 1):
 *   manifests     keyPath transferId (hex string)
 *   blocks        keyPath [transferId, blockIndex]  — verified blocks only,
 *                 per Milestone 4.2's scoping (unverified blocks are never
 *                 written here; they simply get re-received after a reload)
 *   receiveState  keyPath transferId
 */

export const DB_NAME = 'light-spark-transfers';
const DB_VERSION = 1;
const MANIFESTS_STORE = 'manifests';
const BLOCKS_STORE = 'blocks';
const RECEIVE_STATE_STORE = 'receiveState';

interface StoredManifestRecord {
  transferId: string;
  protocolVersion: number;
  fileName: string;
  mimeType: string;
  originalSize: number;
  encodedSize: number;
  blockSize: number;
  blockCount: number;
  sourceChunkSize: number;
  compression: CompressionAlgorithm;
  fileHashAlgorithm: HashAlgorithm;
  fileHash: Uint8Array;
  createdAt?: number;
}

interface StoredBlockRecord {
  transferId: string;
  blockIndex: number;
  data: Uint8Array;
}

/** True if this environment has a usable `indexedDB` global at all — cheap
 * to check before even trying to open a database. Doesn't catch every
 * private-mode failure mode (some browsers only fail once `open()` is
 * actually called), which is why `openDatabase` below still handles
 * `onerror`/`onblocked` on top of this. */
export function isIndexedDbSupported(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
  if (!isIndexedDbSupported()) {
    return Promise.reject(new StorageUnavailableError('IndexedDB is not available in this browser or context', 'unsupported'));
  }

  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(dbName, DB_VERSION);
    } catch (cause) {
      // Some browsers (notably older Safari in private browsing) throw
      // synchronously here instead of failing the request asynchronously.
      reject(new StorageUnavailableError('Could not open the transfer database', 'unsupported', cause));
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MANIFESTS_STORE)) db.createObjectStore(MANIFESTS_STORE, { keyPath: 'transferId' });
      if (!db.objectStoreNames.contains(BLOCKS_STORE)) db.createObjectStore(BLOCKS_STORE, { keyPath: ['transferId', 'blockIndex'] });
      if (!db.objectStoreNames.contains(RECEIVE_STATE_STORE)) db.createObjectStore(RECEIVE_STATE_STORE, { keyPath: 'transferId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onblocked = () => reject(new StorageUnavailableError('The transfer database is blocked by another open tab', 'blocked'));
    request.onerror = () => {
      const name = request.error?.name;
      reject(
        new StorageUnavailableError(
          'Could not open the transfer database',
          name === 'QuotaExceededError' ? 'quota-exceeded' : 'unsupported',
          request.error,
        ),
      );
    };
  });
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Runs `fn` against a fresh transaction over `stores` and resolves once the
 * whole transaction commits — not merely once the individual requests `fn`
 * issued have fired, so a caller never observes a "successful" write that
 * the browser then silently rolled back. */
function runTransaction(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    fn(tx);
  });
}

/** Converts an unexpected native error into `StorageUnavailableError` so
 * every call site gets one consistent, catchable error type — Milestone
 * 4.5's "Speicherfehler führen zu einer verständlichen Fehlermeldung". */
async function withStorageErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    if (cause instanceof StorageUnavailableError) throw cause;
    const name = cause instanceof DOMException ? cause.name : undefined;
    throw new StorageUnavailableError(
      `Storage operation failed${name ? ` (${name})` : ''}`,
      name === 'QuotaExceededError' ? 'quota-exceeded' : 'unknown',
      cause,
    );
  }
}

function manifestToRecord(manifest: TransferManifest): StoredManifestRecord {
  return {
    transferId: transferIdToHex(manifest.transferId),
    protocolVersion: manifest.protocolVersion,
    fileName: manifest.fileName,
    mimeType: manifest.mimeType,
    originalSize: manifest.originalSize,
    encodedSize: manifest.encodedSize,
    blockSize: manifest.blockSize,
    blockCount: manifest.blockCount,
    sourceChunkSize: manifest.sourceChunkSize,
    compression: manifest.compression,
    fileHashAlgorithm: manifest.fileHashAlgorithm,
    fileHash: manifest.fileHash,
    createdAt: manifest.createdAt,
  };
}

function recordToManifest(record: StoredManifestRecord): TransferManifest | null {
  const transferId = transferIdFromHex(record.transferId);
  if (!transferId) return null; // corrupted key — shouldn't happen, never trust it anyway
  return { ...record, transferId };
}

export class IndexedDbTransferRepository implements TransferRepository {
  private readonly dbPromise: Promise<IDBDatabase>;

  /** `dbName` defaults to the app's real database and only needs overriding
   * in tests, where each test gets its own isolated name — avoiding
   * `indexedDB.deleteDatabase()`'s "blocked until every open connection
   * closes" semantics as a source of test-to-test interference entirely,
   * rather than having to carefully close every repository after every test. */
  constructor(dbName: string = DB_NAME) {
    this.dbPromise = openDatabase(dbName);
  }

  /** Closes the underlying connection. Not needed in normal browser use
   * (the connection lives for the page's lifetime), but useful for tests
   * and for explicitly releasing the connection before, e.g., deleting the
   * whole database. */
  async close(): Promise<void> {
    (await this.dbPromise).close();
  }

  async saveManifest(manifest: TransferManifest): Promise<void> {
    return withStorageErrors(async () => {
      const db = await this.dbPromise;
      await runTransaction(db, [MANIFESTS_STORE], 'readwrite', (tx) => {
        tx.objectStore(MANIFESTS_STORE).put(manifestToRecord(manifest));
      });
    });
  }

  async loadManifest(transferId: string): Promise<TransferManifest | null> {
    return withStorageErrors(async () => {
      const db = await this.dbPromise;
      const record = await promisifyRequest<StoredManifestRecord | undefined>(
        db.transaction(MANIFESTS_STORE, 'readonly').objectStore(MANIFESTS_STORE).get(transferId),
      );
      return record ? recordToManifest(record) : null;
    });
  }

  async saveBlock(transferId: string, blockIndex: number, data: Uint8Array): Promise<void> {
    return withStorageErrors(async () => {
      const db = await this.dbPromise;
      const record: StoredBlockRecord = { transferId, blockIndex, data };
      await runTransaction(db, [BLOCKS_STORE], 'readwrite', (tx) => {
        tx.objectStore(BLOCKS_STORE).put(record);
      });
    });
  }

  async loadBlock(transferId: string, blockIndex: number): Promise<Uint8Array | null> {
    return withStorageErrors(async () => {
      const db = await this.dbPromise;
      const record = await promisifyRequest<StoredBlockRecord | undefined>(
        db.transaction(BLOCKS_STORE, 'readonly').objectStore(BLOCKS_STORE).get([transferId, blockIndex]),
      );
      return record ? record.data : null;
    });
  }

  async saveReceiveState(state: PersistedReceiveState): Promise<void> {
    return withStorageErrors(async () => {
      const db = await this.dbPromise;
      await runTransaction(db, [RECEIVE_STATE_STORE], 'readwrite', (tx) => {
        tx.objectStore(RECEIVE_STATE_STORE).put(state);
      });
    });
  }

  async loadReceiveState(transferId: string): Promise<PersistedReceiveState | null> {
    return withStorageErrors(async () => {
      const db = await this.dbPromise;
      const record = await promisifyRequest<PersistedReceiveState | undefined>(
        db.transaction(RECEIVE_STATE_STORE, 'readonly').objectStore(RECEIVE_STATE_STORE).get(transferId),
      );
      return record ?? null;
    });
  }

  async listTransfers(): Promise<StoredTransferSummary[]> {
    return withStorageErrors(async () => {
      const db = await this.dbPromise;
      const manifests = await promisifyRequest<StoredManifestRecord[]>(
        db.transaction(MANIFESTS_STORE, 'readonly').objectStore(MANIFESTS_STORE).getAll(),
      );
      const states = await promisifyRequest<PersistedReceiveState[]>(
        db.transaction(RECEIVE_STATE_STORE, 'readonly').objectStore(RECEIVE_STATE_STORE).getAll(),
      );
      const stateByTransfer = new Map(states.map((s) => [s.transferId, s]));

      return manifests.map((manifest): StoredTransferSummary => {
        const state = stateByTransfer.get(manifest.transferId);
        const receivedBytes = state?.receivedBytes ?? 0;
        const progress = manifest.encodedSize === 0 ? (state ? 1 : 0) : Math.min(1, receivedBytes / manifest.encodedSize);
        const completed = (state?.verifiedBlockIndices.length ?? 0) >= manifest.blockCount;
        return {
          transferId: manifest.transferId,
          fileName: manifest.fileName,
          originalSize: manifest.originalSize,
          progress,
          lastUpdatedAt: state?.lastUpdatedAt ?? 0,
          status: completed ? 'completed' : 'receiving',
        };
      });
    });
  }

  async deleteTransfer(transferId: string): Promise<void> {
    return withStorageErrors(async () => {
      const db = await this.dbPromise;
      await runTransaction(db, [MANIFESTS_STORE, BLOCKS_STORE, RECEIVE_STATE_STORE], 'readwrite', (tx) => {
        tx.objectStore(MANIFESTS_STORE).delete(transferId);
        tx.objectStore(RECEIVE_STATE_STORE).delete(transferId);
        // Deletes every block whose compound key starts with this
        // transferId — bounding blockIndex with +/-Infinity is the standard
        // IndexedDB pattern for "match on a key array's leading component".
        tx.objectStore(BLOCKS_STORE).delete(IDBKeyRange.bound([transferId, -Infinity], [transferId, Infinity]));
      });
    });
  }
}
