# ADR 0005: IndexedDB persistence, verified-blocks-only, with fake-indexeddb for tests

*(Numbering note: the roadmap's own suggested ADR list named this file
`0004-indexeddb-resume.md`. That number was used instead for the
block-integrity decision (`0004-block-integrity-via-crc.md`), which wasn't
in the original list but came up during PR 2's implementation. This is
simple sequential renumbering, not a topic change — the original 0001-0003
plus the suggested 0005/0006 topics are otherwise unaffected.)*

## Status

Accepted and implemented (`src/storage/`, integrated into
`src/transfer/receiverSession.ts`).

## Context

Milestone 4 requires persisting verified blocks across a page reload,
without ever calling IndexedDB directly from UI components
(`docs/architecture-audit.md` already flagged this as fully greenfield —
no persistence code existed anywhere before PR 3).

Two implementation questions had to be answered before writing any code:

1. **How is this tested at all?** `vitest.config.ts` runs with
   `environment: 'node'` (a deliberate, working choice — see
   `docs/architecture-audit.md` risk #8: Grid/QR loopback tests already
   prove this keeps the suite fast without `jsdom`). Node has no native
   IndexedDB, and `jsdom` — the obvious "make it browser-like" fallback —
   doesn't implement IndexedDB either. Switching the whole suite to a
   different test environment just for storage tests would undo the
   "no DOM in protocol/codec tests" discipline the rest of the codebase
   already has.
2. **What, exactly, gets persisted?** Milestone 4.2 gives an explicit,
   narrower first-version scope ("Für die erste robuste Version reicht es,
   verifizierte Blöcke dauerhaft zu speichern") — the harder problem
   (persisting in-flight Fountain decoder state so a *partially* decoded
   block survives a reload too) is explicitly deferred, not silently
   dropped.

## Decisions

### 1. `fake-indexeddb` as a dev-only dependency, isolated per test

`fake-indexeddb` (imported via `fake-indexeddb/auto` only inside test
files) is added as a `devDependency` — the first new dependency introduced
by the whole Protocol v2 initiative. It's the de facto standard for this
exact problem (used by `idb`, `Dexie`, and many other IndexedDB-consuming
libraries' own test suites), pure JavaScript, and zero runtime footprint —
it never ships in the production bundle (confirmed: `npm run build`'s
output hash is unchanged by this PR).

Each repository test constructs its own uniquely-named database
(`IndexedDbTransferRepository`'s constructor takes an optional `dbName`,
defaulting to the real app's name in production) rather than sharing one
database and resetting it between tests with `indexedDB.deleteDatabase()`.
That was tried first and caused every test after the first to hang: a
`deleteDatabase()` call blocks until every open connection to that database
closes, and nothing in the initial implementation ever closed a connection.
Per-test database names sidestep the whole problem — no cleanup step, no
connection-lifecycle bookkeeping, tests run in milliseconds. A `close()`
method was still added to `IndexedDbTransferRepository` for the one test
that specifically needs two sequential connections to the *same* database
(simulating a reload), and for any future UI code that wants to release a
connection explicitly.

### 2. Verified blocks only — no in-flight decoder state

Confirmed as the actual implementation, not just the milestone's minimum
suggestion: `ReceiverSession.persistVerifiedBlock` is only ever called from
`tryFinalizeBlock`'s success path (a matching `BlockComplete` CRC, per ADR
0004) — never for a block that's merely `'receiving'` or `'decoded'`
(Fountain-complete but not yet CRC-checked). A reload during an in-progress
block simply re-receives that one block from the top; every *other*,
already-verified block is skipped entirely, unaffected.

## Consequences

- Storage tests run in ~30-200ms total (see `storage.test.ts`,
  `resume.test.ts`) — no slower than any other test file in the suite,
  despite exercising a real (if fake) database, because there's no
  cross-test cleanup overhead.
- `TransferRepository` (the interface, in `storage/types.ts`) has zero
  IndexedDB or DOM types in its signature — `ReceiverSession` depends only
  on that interface, so a future alternative backend (or, more likely, just
  a hand-written mock in a test — see `resume.test.ts`'s
  `AlwaysFailingRepository`) is a drop-in without touching
  `receiverSession.ts` at all.
- A reload loses at most one block's progress (the one that was actively
  decoding, if any) — for any file with more than a handful of blocks, this
  is a small fraction of the transfer, and gets exactly what Milestone 4.2
  asked for without needing to serialize a `FountainDecoder`'s internal
  peeling-equation graph (`core/fountain.ts`'s `pending`/`dependents`
  structures), which would have been substantially more invasive to
  implement and test correctly.
- `ReceiverSession.ingestFrame` became `async` as a direct consequence
  (repository calls are inherently Promise-based) — this changed PR 2's
  existing test call sites (`for (const frame of frames)
  receiver.ingestFrame(frame)` needed `await` added). Verified this wasn't
  silently masking a real behavioural gap: without a `repository` option,
  no code path inside `ingestFrame` ever actually suspends at an `await`
  (confirmed by the fact the *unawaited* calls still passed, before being
  properly fixed to await) — so PR 2's tests exercised identical behavior
  before and after, just now written correctly rather than accidentally.

## Alternatives considered

- **`idb` (the popular IndexedDB Promise wrapper) instead of hand-rolled
  promisification.** Considered — would have saved writing
  `promisifyRequest`/`runTransaction` (about 20 lines). Rejected to keep
  the dependency list minimal (the codebase's existing convention: three
  runtime dependencies total before this initiative — `preact`, `qrcode`,
  `jsqr`) and because the hand-rolled version is small enough to fully
  understand and test directly rather than trust a wrapper's behavior
  around edge cases like transaction auto-commit timing.
- **`jsdom` test environment instead of `fake-indexeddb`.** Rejected: does
  not implement IndexedDB at all, so this wasn't actually a viable option,
  not just a less-preferred one.
- **Persist unresolved droplets / full decoder state**, as the roadmap's
  own optional extension list mentions. Deferred, not rejected outright —
  revisit if real-world reload timing turns out to lose meaningful progress
  in practice (needs the adaptive-profile and real-channel-wiring work from
  later PRs to even be measurable).
