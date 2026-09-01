import type { TransferManifest } from '../protocol/types';

/**
 * Storage layer (Milestone 4). No DOM/IndexedDB types leak into this file —
 * only `indexedDbTransferRepository.ts` touches the actual browser API, so a
 * future alternative backend (or a test double) only needs to implement
 * `TransferRepository`, matching the plan's "IndexedDB nicht direkt aus
 * UI-Komponenten aufrufen" rule at the module level too, not just the UI's.
 */

/**
 * What's persisted about receive progress for one transfer — deliberately
 * minimal for the first version, per Milestone 4.2's own scoping: "Für die
 * erste robuste Version reicht es, verifizierte Blöcke dauerhaft zu
 * speichern. Unvollständige Blöcke dürfen nach Neustart neu empfangen
 * werden." In-flight Fountain decoder state (unresolved equations) is
 * *not* persisted — only which blocks are fully verified, so a resumed
 * transfer skips re-decoding those and nothing else.
 */
export interface PersistedReceiveState {
  readonly transferId: string; // hex, matches protocol/transferId.ts's transferIdToHex
  readonly protocolVersion: number;
  readonly verifiedBlockIndices: readonly number[];
  /** manifest.encodedSize, cached here so listTransfers() doesn't need a
   * second store lookup just to compute progress. */
  readonly totalBytes: number;
  readonly receivedBytes: number;
  readonly lastUpdatedAt: number;
}

export type StoredTransferStatus = 'receiving' | 'completed';

/** One row of the "resume a transfer" list (Milestone 15's "Wiederaufnahmeansicht"). */
export interface StoredTransferSummary {
  readonly transferId: string;
  readonly fileName: string;
  readonly originalSize: number;
  /** 0..1 */
  readonly progress: number;
  readonly lastUpdatedAt: number;
  readonly status: StoredTransferStatus;
}

/**
 * Thrown instead of letting a raw `DOMException`/`Event` escape — Milestone
 * 4.5's "Speicherfehler führen zu einer verständlichen Fehlermeldung" and
 * "Privater Modus oder fehlende IndexedDB-Unterstützung wird sauber
 * behandelt" both land here as one typed, catchable error with a stable
 * `reason`, rather than every call site having to know IndexedDB's own
 * error shapes.
 */
export class StorageUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: 'unsupported' | 'blocked' | 'quota-exceeded' | 'unknown',
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

export interface TransferRepository {
  saveManifest(manifest: TransferManifest): Promise<void>;
  loadManifest(transferId: string): Promise<TransferManifest | null>;

  saveBlock(transferId: string, blockIndex: number, data: Uint8Array): Promise<void>;
  loadBlock(transferId: string, blockIndex: number): Promise<Uint8Array | null>;

  saveReceiveState(state: PersistedReceiveState): Promise<void>;
  loadReceiveState(transferId: string): Promise<PersistedReceiveState | null>;

  listTransfers(): Promise<StoredTransferSummary[]>;
  deleteTransfer(transferId: string): Promise<void>;
}
