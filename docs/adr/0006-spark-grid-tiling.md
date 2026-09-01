# ADR 0006: Spark Grid tiling via fragmentation, not one Fountain droplet per tile

*(Numbering note: the roadmap's suggested list put this topic at `0005`.
That number went to the IndexedDB/resume decision instead — see the note at
the top of `0005-indexeddb-resume.md`. Sequential renumbering only, same
topic as originally planned.)*

## Status

Accepted and implemented (`src/channels/grid/tiles.ts`,
`src/channels/grid/fragmentAssembler.ts`).

## Context

Milestone 5 asks for the Spark Grid's data area to be split into
independent rectangular tiles, so a local defect (glare, a finger, partial
occlusion) costs only the tile(s) actually affected rather than the whole
frame (today: one CRC-32 over the entire frame body, `codec.ts`'s
`encodeGridCells`/`decodeGridCells` — a single corrupted bit anywhere fails
the whole thing).

The roadmap explicitly leaves the mechanism open and asks for a measured
decision: "Alternativ darf jedes Tile ein eigenständiges kleines Droplet
tragen. Der Agent soll nach Analyse der bestehenden Grid-Kapazität
entscheiden, welcher Ansatz weniger Overhead verursacht."

## The two options, and the capacity arithmetic behind the decision

**Option A — one independent Fountain droplet per tile.** Each tile would
carry its own `DataFrameHeader` (11 bytes, `docs/protocol-v2.md` §3.2) plus
whatever's left of `CommonFrameHeader`'s per-frame cost that can't be
amortised across tiles. Every tile is then a fully self-contained,
independently-useful drop — no reassembly step, simpler mental model.

**Option B — fragmentation.** One `CommonFrameHeader`-wrapped Protocol v2
frame (Manifest, Data, or BlockComplete) is serialized once, wrapped in one
frame-level CRC-32 (`fragmentAssembler.ts`'s `wrapFrameForFragmentation`),
and split across as many tiles as needed — each tile paying only a small,
tile-specific header (`tiles.ts`'s `TILE_HEADER_SIZE` = 7 bytes:
`tileIndex` + `tileSequence` + `tileCount` + `fragmentOffset` +
`fragmentLength`) plus its own CRC-32 (4 bytes) — 11 bytes fixed overhead
per tile, reassembled before the *one* shared 27+-byte `CommonFrameHeader`
and frame CRC are paid for at all.

The deciding input is per-tile *capacity*, computed from the existing Grid
presets (`docs/architecture-audit.md` §5.5) partitioned into, for example, a
3×3 tiling (9 tiles):

| Preset | Data area (cells) | Bits/cell | Total data bytes | ÷9 tiles ≈ bytes/tile |
|---|---|---|---|---|
| Grid safe | 26 rows × 28 cols = 728 | 2 | 182 | ~20 |
| Grid normal | 38 × 40 = 1520 | 3 | 570 | ~63 |
| Grid turbo | 54 × 56 = 3024 | 3 | 1134 | ~126 |

Option A's fixed cost per tile is at minimum `DataFrameHeader` (11 bytes) —
and in practice more, since a tile can't cheaply share the 16-byte
`transferId` or the rest of `CommonFrameHeader` across tiles the way
fragmentation's *one* shared header does; each tile would need to either
repeat a meaningful chunk of that header or invent a second, tile-scoped
header format that duplicates most of what `CommonFrameHeader` already
does. Against Grid-safe's ~20 bytes/tile, an 11-byte-plus header is over
half the tile's entire capacity before a single payload byte — clearly not
viable at that preset. Even at Grid-normal's ~63 bytes/tile, a full
per-tile Fountain header (degree, seed, block index, source chunk count) is
a substantial fraction of the tile.

Option B's fixed cost per tile is 11 bytes regardless of preset, and the
*one* shared `CommonFrameHeader`/frame-CRC cost (about 31 bytes: 27 +
`FRAME_CRC_SIZE`) is paid once per reassembled frame, not once per tile —
amortised across however many tiles that frame's generation actually needs.
At Grid-safe's ~20 bytes/tile, 11 bytes of fixed tile overhead still leaves
only ~9 bytes of fragment per tile — tight, but *workable*, and critically,
the *shared* per-frame cost doesn't multiply by tile count the way it would
under Option A.

## Decision

**Fragmentation (Option B).** Implemented in `tiles.ts` (tile geometry,
per-tile CRC-32-protected payload) and `fragmentAssembler.ts`
(`FrameFragmentAssembler`, frame-level CRC-32 on top). One Protocol v2 frame
is fragmented across tiles; tiles carry no Fountain-specific fields of their
own at all — a Data frame's `DataFrameHeader` and drop payload are simply
*part of the frame bytes being fragmented*, transparent to the tiling layer.

This also directly determines Milestone 8.3's two-stage validity check,
implemented exactly as specified:

1. Classify cells → 2. read tile header → 3. check tile CRC (`tiles.ts`'s
   `decodeTilePayload`) → 4. pass valid tiles to the assembler → 5. assemble
   fragments (`FrameFragmentAssembler.ingestTile`) → 6. check the
   *reassembled frame's* CRC (same method, after step 5 succeeds) → 7. only
   then would a caller hand the result to `decodeCommonFrameHeader` (not
   part of this PR — see below).

## Consequences

- **`render.ts`/`detect.ts` are completely untouched.** Both already treat
  the grid's data area as an opaque flat `cells: Uint8Array` — tiling is
  purely a different way of *interpreting* that same array
  (`tiles.ts`'s doc comment). Confirmed directly:
  `tileLoopback.test.ts` renders and detects tiled frames through the
  *exact same* `renderGrid`/`detectGrid` functions the monolithic format
  already uses, with zero modifications to either.
- **Works at every preset**, including Grid-safe, where Option A's per-tile
  header overhead would have been prohibitive. The actual tiling density
  (`tileRows`/`tileCols`) is left as a caller-supplied parameter rather than
  hard-coded per preset — a future PR wiring this into a real sender picks
  the density, informed by real capture-quality measurements this codebase
  doesn't have yet (Milestone 6's adaptive profiles).
- **A tile carries no Fountain semantics.** This means a *Manifest* frame
  (which has nothing to do with Fountain codes) fragments through the exact
  same mechanism as a *Data* frame's drop — one assembler, one code path,
  regardless of what's inside the reassembled bytes.
- **Two independent CRC checks per frame** (every tile's own, then the
  reassembled whole's) cost a few extra bytes over a hypothetical
  single-check design, but this is what actually delivers "verdeckung eines
  Tiles zerstört nicht alle anderen Tiles" *and* "unvollständige Frames
  werden nie an den Decoder weitergereicht" as two separately-testable
  guarantees (`tiles.test.ts` and `fragmentAssembler.test.ts` each exercise
  one in isolation, per Milestone 8.5's explicit "Tile-CRC und Frame-CRC
  sind unabhängig testbar").
- **Not yet wired into `GridBeamSource`/`GridReceiver`.** This PR delivers
  the tiling primitives themselves, fully tested end-to-end through the
  real vision pipeline — but the actual sender-side policy questions (how
  many tiles per preset, what fills unused tile slots when one frame's
  content doesn't need all of them, how `tileSequence` increments across
  paints) are real design decisions for whoever wires this into a live
  channel, deliberately left open here the same way PR 1-3 left
  `SenderSession`/`ReceiverSession` unwired into any UI screen.
- **Old (monolithic) Spark Grid stays fully recognisable and untouched.**
  `codec.ts`'s `encodeGridCells`/`decodeGridCells` are not modified by this
  PR at all — the "protocol version" distinction Milestone 8.5 asks for
  ("Alte Spark-Grid-Version bleibt über die Protokollversion erkennbar")
  is satisfied structurally: a receiver that doesn't know about tiling
  keeps working exactly as before, since nothing about the existing v1
  wire format changed.

## Alternatives considered

- **Option A (one droplet per tile), restricted to Grid-normal/turbo only,
  falling back to monolithic on Grid-safe.** Considered — would have kept
  Option A's "no reassembly step" simplicity where the capacity supports
  it. Rejected in favour of one uniform mechanism across all presets:
  maintaining two entirely different tiling strategies (with two sets of
  tests, two failure modes, two things to keep in sync) for a
  capacity-driven edge case wasn't judged worth it, especially since
  fragmentation works fine — just tightly — even at Grid-safe.
- **Merkle-tree-style hierarchical tile grouping** (group tiles into larger
  super-tiles with their own intermediate CRC, reducing the number of
  independent CRC checks at the cost of coarser fault isolation).
  Considered as a middle ground; rejected as unnecessary complexity without
  a demonstrated need — flat per-tile CRCs are cheap (4 bytes) and simple,
  and coarser fault isolation is exactly what this milestone is trying to
  move *away* from.
