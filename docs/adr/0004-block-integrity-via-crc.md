# ADR 0004: Block integrity via a separate CRC-32 BlockComplete frame, not a manifest field

## Status

Accepted and implemented (`src/protocol/blockComplete.ts`,
`ReceiverSession`/`SenderSession` in `src/transfer/`).

## Context

Milestone 2.5 requires every block to carry "einen Hash oder eine starke
Prüfsumme", and explicitly allows deferring the harder cases: "Falls die
Manifestgröße dadurch zu groß wird, alternativ einen Merkle-Root oder
separate Block-Metadatenframes vorsehen. Für die erste Version sind
Block-Hashes akzeptabel, sofern die maximal unterstützte Blockanzahl sinnvoll
begrenzt wird."

The roadmap's `TransferManifest` sketch has an optional `blockHashes?:
Uint8Array[]` field for this. But PR 1's manifest capacity work
(`docs/protocol-v2.md` §5) already found the manifest's field budget razor-
thin against QR-safe's frame capacity — 133 bytes worst case against a
133-byte budget, zero bytes of slack (`docs/architecture-audit.md` §10).
Adding a `blockHashes` array, even one CRC-32 (4 bytes) per block, would
break that fit almost immediately: `MAX_BLOCK_COUNT` is 65,535, and even a
handful of blocks' worth of hashes would no longer fit in a single manifest
frame — the manifest would need fragmentation a whole milestone early
(Milestone 5 territory), which `docs/protocol-v2.md` §3.1 explicitly
designed to avoid for v2.0's manifest.

Meanwhile SHA-256 (the algorithm the *file-level* `fileHash` field already
commits to) isn't implemented anywhere yet — that's Milestone 8 / PR 7's
job, deliberately not pulled forward into PR 2.

## Decision

Block integrity travels in its own frame type, `FrameType.BlockComplete`
(already reserved as value `3` since PR 1, previously undefined) —
`docs/protocol-v2.md` §3.1's own text anticipated this: "Per-block integrity
is planned to travel in `BlockComplete` frames once Milestone 2 actually
implements blocks."

Payload (`src/protocol/blockComplete.ts`): `blockIndex` (`uint32`) +
`blockCrc32` (`uint32`) — 8 bytes, using the same CRC-32 (IEEE) algorithm
already used throughout this codebase (Grid frames, the v1 envelope) rather
than a new primitive. The sender computes each block's CRC once, at
`SenderSession` construction (it already holds the true bytes), and repeats
the `BlockComplete` frame for the currently active block cyclically — the
same pattern the Manifest frame already uses, and for the same reason: a
receiver that joins mid-transmission, or loses a few frames, still gets one
eventually, with no back-channel required.

A block's `FountainDecoder` completing (`isComplete`) is *not* sufficient on
its own to mark it `'verified'`: `ReceiverSession` also requires a matching
`BlockComplete` CRC before promoting a block past `'decoded'`. This is the
direct mitigation for a risk flagged in `docs/architecture-audit.md` (#6):
QR in particular has no per-packet integrity check independent of the QR
symbol's own error correction, so a corrupted-but-plausible drop can poison
a Fountain graph's XOR equations without the graph itself ever noticing —
the CRC is what catches that, the same way the *whole-file* CRC-32 already
does for v1's single-graph transfers, just now scoped to one block so a
single bad drop doesn't cost the whole transfer.

## Consequences

- The manifest's field budget (`docs/protocol-v2.md` §5) is completely
  unaffected — no `blockHashes` array, no size growth, no re-litigating the
  already-tight QR-safe fit.
- A block that fails its CRC check restarts from scratch (`ReceiverSession`
  discards the decoder and clears the block's entry) rather than being
  "half-trusted" — there's no way to identify *which* drop poisoned the
  graph after the fact, so the only safe recovery is a clean retry, which
  arrives automatically since the sender keeps cycling the block anyway.
- A `BlockReceiveState.status` value the roadmap's own sketch already
  defines, `'decoded'`, becomes meaningful precisely because of this design:
  it's the state between "Fountain-complete" and "CRC-verified" — a block
  can sit there for a while if drops arrive faster than `BlockComplete`
  frames do, which is expected and not an error.
- **Explicitly not solved by this decision**: file-level integrity.
  `manifest.fileHash` (SHA-256) is still carried through untouched and
  unverified — `ReceiverSession.getAssembledData()` returns the
  block-CRC-verified concatenation of all blocks, but nothing yet checks it
  against `fileHash`. That remains Milestone 8 / PR 7's job, same as before
  this ADR.
- Cost: one small, low-frequency frame type per transfer, at a repeat cadence
  independent of (and typically much lower than) Data frames — negligible
  channel-capacity impact compared to a manifest-embedded array that would
  have to repeat on *every* manifest resend regardless of block count.

## Alternatives considered

- **`blockHashes: Uint8Array[]` in the manifest, as literally sketched.**
  Rejected: breaks the already-tight manifest capacity fit, as shown above.
- **Merkle root over all blocks, single hash in the manifest.** Considered —
  fits the manifest budget fine (one fixed-size root), and the roadmap
  explicitly allows it as an alternative. Rejected for PR 2 specifically
  because it requires a real hash function (SHA-256 or similar) to be
  meaningful, which doesn't exist yet in this codebase (Milestone 8), and
  because it only proves the *set* of blocks is correct once *all* of them
  are in hand — it doesn't let a single block be verified independently
  the moment it's decoded, which is exactly the property Milestone 2.5 is
  going for (fault isolation, matching ADR 0001's whole rationale for
  blocks in the first place). Worth revisiting once SHA-256 exists, as a
  *replacement* for the per-block CRC-32 rather than an addition — noted for
  Milestone 8 / PR 7, not decided here.
- **Wait for Milestone 8's SHA-256 and use it for blocks too, skip block
  integrity in PR 2 entirely.** Rejected: leaves the exact risk this ADR
  addresses (architecture-audit.md risk #6) completely unmitigated for the
  whole span between PR 2 and PR 7, on the very feature (block transfer)
  that makes a single corrupted drop's blast radius newly relevant (in v1,
  one bad drop can already ruin a whole-file transfer — blocks are supposed
  to *improve* on that, not carry it forward unaddressed).
