# ADR 0001: Block-based transfer instead of one whole-file Fountain graph

## Status

Accepted. Types and wire format defined in PR 1 (`src/protocol/`); actual
block splitting, `SenderSession`/`ReceiverSession`, and bounded-memory
decoding are PR 2 (Milestone 2) — not yet implemented.

## Context

v1 treats an entire transfer as a single Luby-Transform Fountain code graph:
`FountainEncoder`/`FountainDecoder` (`core/fountain.ts`) operate over the
whole envelope at once, and `TransferAssembler` (`core/assembler.ts`) holds
exactly one `FountainDecoder` for the life of a transfer. This has three
consequences that the roadmap explicitly asks to remove:

1. **No resumability.** A page reload, camera interruption, or app restart
   discards 100% of decode progress — there is nothing to persist that would
   let a receiver pick back up, because "progress" only exists as in-memory
   peeling state inside one big decoder instance.
2. **Unbounded memory growth with file size.** `FountainDecoder`'s `chunks`
   array is sized to the whole file's chunk count up front. The
   already-shipped `MAX_TOTAL_BYTES`/`MAX_CHUNK_COUNT` caps in
   `core/packet.ts` bound this to a single, blunt, whole-transfer ceiling —
   they prevent a crafted-packet crash, but they don't let a genuinely large,
   legitimate file be handled with a small, constant memory footprint.
3. **No independent fault isolation.** A corrupted or lost region of the
   file can't be reasoned about separately from any other region — there is
   only "the whole file is done" or "the whole file is not done yet".

## Decision

Split every transfer into independently-addressed **blocks** (`blockIndex`,
`blockSourceChunkCount` — see `docs/protocol-v2.md` §3.2), each with its own
Fountain code graph. A block is the unit of:

- **Memory bounding**: only a configurable number of block decoders are ever
  live in memory at once (Milestone 2.4) — a block's `chunks` array is sized
  to that block's chunk count, not the whole file's.
- **Persistence**: a *verified* block (Milestone 8's SHA-256, or an interim
  per-block checksum before that lands) is the smallest unit written to
  IndexedDB (Milestone 4) and the smallest unit a resumed transfer can skip
  re-decoding.
- **Progress**: `ReceiverSessionState.blocks: BlockReceiveState[]`
  (per the roadmap) reports per-block status, not just one global percentage.

`TransferManifest.blockSize`/`blockCount` (§4 of `protocol-v2.md`) describe
this partitioning; `DataFrameHeader.blockIndex` tags every drop with which
block's graph it belongs to.

## Consequences

- **v1 is untouched and stays working.** `core/fountain.ts`,
  `core/packet.ts`, `core/protocol.ts`, `core/assembler.ts` are not modified
  by this decision — v1 transfers (single Fountain graph, no blocks) keep
  running exactly as they do today, gated behind the v1 packet magic byte
  (`0xA7`) rather than the v2 magic (see ADR 0002). Block-based transfer is
  purely additive.
- **`core/fountain.ts`'s `FountainEncoder`/`FountainDecoder` are reused, not
  rewritten**, per the roadmap's explicit "kapseln und optimieren, statt neu
  schreiben" guidance for Milestone 3 — a v2 receiver will construct one
  `FountainDecoder` per active block rather than one per transfer. The
  encoder/decoder classes themselves don't need to know about blocks at all;
  block orchestration is a layer above them (`transfer/` in the target
  architecture, `architecture-audit.md` §8).
- **A block boundary is also a natural place to add a per-block hash later**
  (Milestone 8) without redesigning the transfer/session layer again —
  `BlockReceiveState.status` already has a `'verified'` state reserved for
  this in the roadmap's own sketch.
- **Cost**: per-drop header overhead grows (an extra `blockIndex` +
  `blockSourceChunkCount` per frame, 6 of `DataFrameHeader`'s 11 bytes) —
  accepted as the price of resumability and bounded memory, and small
  relative to the channel capacities involved (`architecture-audit.md` §5.5).

## Alternatives considered

- **Keep one Fountain graph, add checkpointing.** Rejected: doesn't bound
  memory for large files, and "resume" would still mean re-deriving a huge
  decoder's peeling state rather than skipping already-verified data
  entirely.
- **Fixed, uniform chunk count instead of blocks.** Rejected: doesn't solve
  fault isolation or give a natural persistence unit smaller than "the whole
  file".
