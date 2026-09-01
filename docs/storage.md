# Storage (Milestone 4)

Status: **implemented** — `src/storage/` (repository interface + IndexedDB
backend) and its integration into `src/transfer/receiverSession.ts` (PR 3).
Not yet wired into any UI screen — no "resume a transfer" list exists yet
(Milestone 15's "Wiederaufnahmeansicht" is future UI work); `listTransfers()`
and `deleteTransfer()` are fully implemented and tested, just not called
from anywhere in `ui/` yet.

## Module boundary

```
storage/
  types.ts                        TransferRepository interface, PersistedReceiveState,
                                   StoredTransferSummary, StorageUnavailableError — no DOM types here
  indexedDbTransferRepository.ts  the only file that touches the real IndexedDB API
  storage.test.ts                 repository unit tests (via fake-indexeddb)
```

`transfer/receiverSession.ts` depends only on the `TransferRepository`
*interface*, never on `indexedDbTransferRepository.ts` directly — matching
the roadmap's "IndexedDB nicht direkt aus UI-Komponenten aufrufen" rule
applied one layer further in than just the UI: a test double, or a future
alternative backend, only needs to implement the six-method interface.

## Schema

One IndexedDB database (`light-spark-transfers`, version 1), three object
stores:

| Store | Key | Value |
|---|---|---|
| `manifests` | `transferId` (hex string) | The full `TransferManifest`, flattened — `transferId` re-derived from the key on load via `protocol/transferId.ts`'s `transferIdFromHex` |
| `blocks` | `[transferId, blockIndex]` (compound array key) | `{ transferId, blockIndex, data: Uint8Array }` — **verified blocks only**, see below |
| `receiveState` | `transferId` (hex string) | `PersistedReceiveState`: `verifiedBlockIndices`, `totalBytes`, `receivedBytes`, `lastUpdatedAt` |

**Deliberately not stored** (Milestone 4.2's own scoping: "Für die erste
robuste Version reicht es, verifizierte Blöcke dauerhaft zu speichern.
Unvollständige Blöcke dürfen nach Neustart neu empfangen werden."):

- In-flight Fountain decoder state (unresolved XOR equations) for a block
  that's only partway decoded — if the page reloads mid-block, that block's
  progress is lost and it's received again from scratch. Only *fully
  verified* blocks (matched against their `BlockComplete` CRC — see ADR
  0004) are ever written to the `blocks` store.
- Calibrated camera settings, channel profile choice — not yet a concept
  that exists anywhere in the codebase (Milestone 6/9 territory).

## Why verified-only, and why this doesn't lose progress in practice

Because the sender has no feedback channel and cycles every block forever
(`SenderSession`, ADR 0001), a block that was mid-decode at reload time will
simply have its drops re-sent later in the stream anyway — nothing about
the *transfer* is lost, only that one block's *local, unpersisted* partial
progress, which was never guaranteed to survive a reload in the first place
even before this milestone (v1 had no persistence at all). What resume
actually buys is skipping re-decode for every block that already finished
**before** the reload — for a large multi-block file, that's most of the
transfer.

## Resume flow (Milestone 4.3)

Implemented in `ReceiverSession.ingestManifest` (`transfer/receiverSession.ts`):

1. A `Manifest` frame decodes successfully.
2. If a `repository` was supplied to the `ReceiverSession`, look up
   `transferId` in storage.
3. **No stored manifest** → new transfer. Save the manifest immediately
   (durable from the first frame, not only once a block completes).
4. **Stored manifest matches** (byte-for-byte equal, sans `transferId`/
   `protocolVersion`, which live in the frame header — see
   `docs/protocol-v2.md` §4) → this is a resume. Load
   `PersistedReceiveState.verifiedBlockIndices`, and for each one, load its
   bytes and mark that block `'verified'` directly — no `FountainDecoder` is
   ever constructed for an already-verified block. `state.resumed` becomes
   `true`. Only the blocks *not* in that list are left open to receive
   normally.
5. **Stored manifest differs** → conflict (Milestone 4.4, below).

A block verified *during* the current session (not from resume) is
persisted the moment its CRC check passes (`ReceiverSession.persistVerifiedBlock`):
the block's bytes, plus a freshly recomputed `PersistedReceiveState`
(`verifiedBlockIndices` derived from the in-memory `completedBlockBytes` map,
`receivedBytes` summed from `BlockPlan.getBlockRange`, `lastUpdatedAt =
Date.now()`).

## Conflict handling (Milestone 4.4)

A manifest that doesn't match what's already stored for the same
`transferId` is **never applied**: the incoming manifest is rejected (counted
in `rejectedFrames`, not `validFrames`), nothing already in storage is
touched, and `ReceiverSessionState.status` becomes `'failed'` with
`failureReason` set to a human-readable description (safe to show directly
in a diagnostics view — see `docs/protocol-v2.md`'s security-model
precedent in the main `README.md` for why messages shown to a user never
include payload bytes or full raw IDs by default).

This is a genuine stop, not a soft warning: there's no principled way for
the receiver to guess which of two differing manifests for the same 128-bit
ID is "correct" — that ID isn't a security boundary (see
`protocol/transferId.ts`'s doc comment), so a collision or replay isn't
expected to be malicious in the common case, but the safe response is
identical either way: don't guess, don't overwrite, report.

## Storage failures (Milestone 4.5)

Every `IndexedDbTransferRepository` method funnels unexpected errors through
one conversion (`withStorageErrors` in `indexedDbTransferRepository.ts`)
into `StorageUnavailableError` — a typed, catchable error with a stable
`reason` (`'unsupported' | 'blocked' | 'quota-exceeded' | 'unknown'`) rather
than a raw `DOMException`. `isIndexedDbSupported()` gives a cheap
pre-check; `openDatabase`'s `onerror`/`onblocked` handlers catch the rest,
including private-browsing modes where `indexedDB` exists as a global but
fails once actually used.

Crucially, a storage failure **does not stop the current session from
receiving**: `ReceiverSession` catches every repository call, records the
failure in `state.failureReason`, and continues — the only thing lost is
*this session's* ability to persist (and therefore resume after a reload)
whichever specific operation failed. A transfer can still complete
end-to-end, in memory, entirely normally with a completely broken storage
backend; the roadmap's own framing ("Speicherfehler führen zu einer
verständlichen Fehlermeldung", not "brechen den Empfang ab") is taken
literally here. See `src/transfer/resume.test.ts`'s
`AlwaysFailingRepository` test for this exercised directly.

The one exception: a **manifest conflict** genuinely does stop the
transfer (see above) — that's not a storage failure, it's a real, resolved
disagreement about what's being received, and continuing would risk
silently mixing two different files' blocks together.

## What a future UI layer needs (not yet built)

- A "resume a transfer" list: `repository.listTransfers()` already returns
  everything needed (`StoredTransferSummary`: file name, size, progress
  0..1, last-updated timestamp, `'receiving' | 'completed'` status).
- Delete: `repository.deleteTransfer(transferId)`.
- Constructing a `ReceiverSession({ repository })` and feeding it a fresh
  manifest for a transfer the user picked from that list is the entire
  "resume" action from the UI's perspective — everything else described
  above happens automatically inside `ingestManifest`.
