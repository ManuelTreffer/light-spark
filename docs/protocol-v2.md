# Protocol v2 — Wire Format

Status: **implemented.** `src/protocol/` (types, binary (de)serialization,
golden-vector tests) as of PR 1 / Milestone 1; `BlockComplete` (§3.3) and the
block-orchestration layer that actually uses this format (`src/transfer/`:
`SenderSession`, `ReceiverSession`, `BlockPlan`) as of PR 2 / Milestone 2.
Every field width below is derived from the actual capacity of the existing
channels (see `architecture-audit.md` §5.5), not chosen arbitrarily. All open
questions from the original draft are resolved as of §6 below. **Still not
wired into any real channel** — `SenderSession`/`ReceiverSession` produce and
consume raw frame bytes, channel-agnostically; no QR/Grid adapter displays or
captures them yet, and neither does any UI screen (that's a later PR).

All multi-byte integers are **big-endian**, matching the existing v1 formats
(`core/packet.ts`, `core/protocol.ts`) — chosen for consistency, not because
big-endian has any technical edge here.

---

## 1. Coexistence with v1 — how a receiver tells the formats apart

v1's `packet.ts` format starts with a single magic byte `0x A7`. Protocol v2
frames start with a **two-byte magic `0x4C 0x53` ("LS")**, which cannot
collide with a v1 packet: a v1 receiver checks `bytes[0] === 0xA7` and would
reject `0x4C` outright; a v2 receiver checks the 2-byte magic first and falls
back to attempting v1 decode only if that doesn't match. This lets a single
QR/Grid receiver implementation try v2 first, then v1, per frame, with no
ambiguity — see ADR `0002-protocol-versioning.md`.

The v1 envelope format (`"LSPK"`, 4-byte magic) is unrelated and unaffected —
v2 does not reuse or extend it; v2 defines its own `TransferManifest` instead
(§4). v1 transfers (old sender talking to a receiver that also understands
v2) still work unmodified: the v2 magic simply never matches, and the
existing v1 decode path runs exactly as it does today.

---

## 2. Common Frame Header

Present at the start of **every** v2 frame, regardless of `frameType`.

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 2 | magic | `uint16` | fixed `0x4C53` ("LS") |
| 2 | 1 | protocolVersion | `uint8` | `2` for this document. See §6.1 for why this is separate from the magic. |
| 3 | 1 | frameType | `uint8` | see §3 |
| 4 | 1 | flags | `uint8` | bitfield, see below |
| 5 | 16 | transferId | `16 bytes` | random, generated once per transfer by the sender (`crypto.getRandomValues`) — see §6.2 for the width discussion |
| 21 | 4 | sequenceNumber | `uint32` | monotonically increasing per transfer, counts *all* frames (any type) sent by this sender instance; used for de-duplication and (later) feedback references. Wraps at 2^32 — a transfer would need to run for a very long time at any realistic fps to wrap; wrap is not specially handled in v2.0, flagged as a non-issue rather than ignored. |
| 25 | 2 | payloadLength | `uint16` | length of the payload that follows this header (plus, for `Data` frames, the `DataFrameHeader` below) |

**Total: 27 bytes.** (One byte more than earlier sketches that assumed a
1-byte magic — the 2-byte magic is deliberate, see §1.)

### flags bitfield (bit 0 = LSB)

| Bit | Name | Meaning when set |
|---|---|---|
| 0 | `SYSTEMATIC` | (Data frames only) this drop is a verbatim source chunk, not a combinatorial Fountain drop — mirrors v1's existing `seed < chunkCount` convention (see §3.2, and ADR `0003-deterministic-fountain-seeding.md`) |
| 1–7 | reserved | **must be 0 on send; must be ignored (not rejected) on receive.** This is the mechanism that satisfies the plan's "unbekannte optionale Flags dürfen nicht zum Absturz führen" requirement — a receiver that doesn't understand a future flag simply doesn't look at that bit, and continues parsing the rest of the frame normally. No flag in v2.0 is allowed to change the *layout* of the header that follows it; a layout-changing addition needs a `protocolVersion` bump instead. |

### Unknown-value behavior (required for every field above)

- **Unknown `protocolVersion`** (i.e. not `2`, once this is the only version
  defined): reject the frame (return `null`/`undefined` from the decoder),
  do not attempt to interpret the remaining bytes under a guessed layout.
  A future v3 receiver is expected to special-case v2 explicitly if it needs
  to stay compatible, not to assume forward compatibility.
- **Unknown `frameType`**: reject. Frame types are not designed to be
  forward-compatible the way flag bits are — a truly optional, ignorable
  addition should be a new flag or a new manifest field, not a new frame
  type, precisely so old receivers can skip it safely. An unrecognised
  frame type is either corruption or a real protocol extension that requires
  a version bump to be safely ignorable.
- **`payloadLength` inconsistent with the actual remaining buffer length**
  (i.e. `header size + payloadLength > bytes.length`): reject before reading
  any payload bytes. This is the direct generalisation of the DoS fix already
  shipped in `core/packet.ts` (`MAX_TOTAL_BYTES`/`MAX_CHUNK_COUNT`) — no
  allocation or read happens against a length claim that isn't already
  physically backed by the buffer in hand.
- **Reserved flag bits set**: ignored, not rejected (see above).

---

## 3. Frame types

```ts
enum FrameType {
  Manifest = 1,
  Data = 2,
  BlockComplete = 3,     // implemented as of PR 2 — see §3.3
  TransferComplete = 4,  // reserved, not sent in v2.0
  Capability = 5,        // reserved, not sent in v2.0
  Feedback = 6,          // reserved, not sent in v2.0 — Milestone 10
}
```

`Manifest`, `Data`, and (as of PR 2) `BlockComplete` are actually emitted.
`TransferComplete`, `Capability`, and `Feedback` are reserved *in the enum*
now so their numeric values never get reassigned later, but a v2.0 receiver
treats any of them as "structurally valid but nothing to do yet" rather than
"unknown" — i.e. it recognizes the frame type, decodes the
`CommonFrameHeader`, and then simply has no handler for the payload. This is
different from a truly unknown `frameType` byte (§2), which is rejected
outright.

### 3.1 Manifest frame

`frameType = 1`. Payload is a serialized `TransferManifest` (§4). No
`DataFrameHeader`. Sent cyclically, repeated, interleaved with `Data` frames
by the sender — not fragmented across frames (see §5 for why the field
budget is deliberately kept small enough to avoid needing that in v2.0).

### 3.2 Data frame

`frameType = 2`. `CommonFrameHeader` is immediately followed by a
`DataFrameHeader`, then the drop payload.

| Offset (from end of CommonFrameHeader) | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 4 | blockIndex | `uint32` | which block this drop belongs to |
| 4 | 2 | blockSourceChunkCount | `uint16` | number of source chunks in *this* block (blocks can differ, e.g. the last, shorter block) — max 65,535, see §6.4 for why this is intentionally the same order of magnitude as the existing `MAX_CHUNK_COUNT` |
| 6 | 4 | dropletSeed | `uint32` | same role as v1's `seed`: PRNG input for `pickIndices(seed, blockSourceChunkCount)` |
| 10 | 1 | dropletDegree | `uint8` | **redundant with what `pickIndices(dropletSeed, blockSourceChunkCount)` would recompute deterministically** — included anyway so a receiver can sanity-check a decoded degree against the claimed one *before* running the (more expensive) chunk-selection PRNG, and reject a corrupted header early. Doubles as an explicit protocol-level cap: a `dropletDegree` byte can never claim more than 255, which is also enforced as the Fountain layer's max-degree limit (Milestone 3.4). |

**`dropletIndex` is not a separate wire field.** The plan's `DataFrameHeader`
interface marks it optional (`dropletIndex?: number`); v2.0 folds it into the
existing v1 convention instead of spending 4 more bytes on it:
`dropletSeed < blockSourceChunkCount` ⇒ this drop *is* systematic, and the
chunk index *is* `dropletSeed` — identical to how `pickIndices` already
behaves in `core/fountain.ts` today. The `SYSTEMATIC` flag bit (§2) is set in
this case, purely as a fast-path hint for the receiver (skip the PRNG call
entirely, use `dropletSeed` as the literal chunk index) — a receiver that
ignores the flag still gets the correct answer by running `pickIndices` as
normal, since `pickIndices` already special-cases `seed < k`. This is
recorded as a deliberate deviation from the plan's literal interface shape in
ADR `0003-deterministic-fountain-seeding.md`.

**`DataFrameHeader` total: 11 bytes.**

**Total per-frame overhead for a Data frame: 27 (common) + 11 (data) = 38
bytes**, vs. v1's 13-byte `PACKET_HEADER_SIZE`. See §5 for what this costs in
practice per channel/preset.

### 3.3 BlockComplete frame

`frameType = 3`, implemented as of PR 2 (Milestone 2.5, block integrity —
see ADR `0004-block-integrity-via-crc.md` for why this is a separate frame
rather than a manifest field or a wait for Milestone 8's SHA-256). No
`DataFrameHeader`. Payload:

| Offset (from end of CommonFrameHeader) | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 4 | blockIndex | `uint32` | which block this CRC applies to |
| 4 | 4 | blockCrc32 | `uint32` | CRC-32 (IEEE) over that block's reconstructed source bytes — the same algorithm already used elsewhere in this codebase (Grid frames, the v1 envelope) |

**Total: 8 bytes.** Sent cyclically for the currently active block, the same
repeat pattern the Manifest frame uses and for the same reason: no
back-channel exists to ask for it, so it simply comes back around. A block
is only reported `'verified'` (`BlockReceiveState.status`) once its
Fountain-reconstructed bytes match a `blockCrc32` received for it — not
merely once its `FountainDecoder` reports `isComplete`, which only proves
the drops received were *internally consistent with each other*, not that
none of them were corrupted-but-plausible in the first place (see
`docs/architecture-audit.md` risk #6).

---

## 4. Transfer Manifest

Serialized form of `TransferManifest`, carried as the payload of a `Manifest`
frame (§3.1) — `transferId` is **not** repeated here, it's already in the
wrapping `CommonFrameHeader`.

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 1 | fileNameLength | `uint8` | 0–44 (see §5) |
| 1 | fileNameLength | fileName | UTF-8 | sanitized the same way v1 already sanitizes received names (`sanitizeName`: strip Unicode bidi-control chars) before ever reaching the DOM or a download attribute |
| 1+N | 1 | mimeTypeLength | `uint8` | 0–32 (see §5) |
| 2+N | mimeTypeLength | mimeType | UTF-8 (ASCII in practice) | not trusted for content-type sniffing decisions, matching the existing `README.md` security-model note ("MIME-Type nicht blind vertrauen") |
| 2+N+M | 4 | originalSize | `uint32` | bytes, pre-compression; validated `≤ MAX_TRANSFER_BYTES` (proposed 256 MiB, see §6.6) |
| 6+N+M | 4 | encodedSize | `uint32` | bytes, post-compression (or equal to `originalSize` if `compression = none`) |
| 10+N+M | 4 | blockSize | `uint32` | bytes per block (before the last, possibly-shorter block) |
| 14+N+M | 2 | blockCount | `uint16` | `ceil(encodedSize / blockSize)`, sender-computed, receiver-validated against `encodedSize`/`blockSize` rather than trusted blindly |
| 16+N+M | 2 | sourceChunkSize | `uint16` | Fountain source-chunk size within a block (matches v1's existing `chunkSize` field width) |
| 18+N+M | 1 | compression | `uint8` enum | `0 = none`, `1 = deflate` (see §6.3 for the naming note vs. the plan's `"gzip"`) |
| 19+N+M | 1 | fileHashAlgorithm | `uint8` enum | `1 = sha256` is the only defined value in v2.0; `0` is reserved/invalid (a v2 manifest always carries a SHA-256, per the plan's explicit Milestone 8 requirement — this field exists for a hypothetical future algorithm, not to make hashing optional) |
| 20+N+M | 32 | fileHash | 32 bytes | SHA-256 digest of the **original** (pre-compression) file, via `crypto.subtle.digest` — no self-implementation |
| 52+N+M | 1 | createdAtPresent | `uint8` | `0` or `1` — informative-only field is optional on the wire, per the plan ("createdAt darf nur informativ sein und nicht für die Validität benötigt werden") |
| 53+N+M | 0 or 4 | createdAt | `uint32`, only present if `createdAtPresent = 1` | Unix seconds; **never used in any validity check**, purely diagnostic. Valid until 2106 (uint32 seconds) — acceptable given it's informative-only |

Fixed, non-length-prefix overhead (`originalSize` through `createdAtPresent`,
i.e. everything except the two length bytes, the name/mime content, and the
optional `createdAt`): 4+4+4+2+2+1+1+32+1 = **51 bytes**. Adding the 2
length-prefix bytes (`fileNameLength` + `mimeTypeLength`, always present even
when empty) gives a **minimum manifest size of 53 bytes** (empty name, empty
mime, no timestamp). With `fileName` and `mimeType` at their full caps
(44 + 32) and `createdAt` present: 53 + 44 + 32 + 4 = **133 bytes worst
case**; without `createdAt`, 129 bytes.

*(An earlier draft of this document mislabeled this sum as "51 bytes
including the 2 length bytes" and used a since-superseded 48-byte `fileName`
cap, understating the true worst case. Fixed here — see §5 for what that
means for the capacity check, which the 44-byte cap below still resolves,
now correctly accounted for.)*

`blockHashes` (the plan's §5.5 optional per-block-hash list) is **not**
part of the v2.0 manifest. Per-block integrity is planned to travel in
`BlockComplete` frames once Milestone 2 actually implements blocks (the
manifest doesn't know block hashes yet at Milestone 1, since blocks don't
exist as a wire concept until PR 2) — noted here so the manifest's own field
list doesn't grow speculatively ahead of the milestone that needs it.

---

## 5. Capacity check — does the manifest actually fit?

Using the table from `architecture-audit.md` §5.5 (chunk payload bytes
available *to `packet.ts`* in v1 — for v2, that same raw channel capacity is
now split between the 27-byte `CommonFrameHeader` and the frame payload,
since Manifest frames carry no `DataFrameHeader`):

| Channel/preset | Raw channel payload capacity (bytes) | − CommonFrameHeader (27) | Manifest budget |
|---|---|---|---|
| QR safe | 160 | 27 | **133** |
| QR normal | 340 | 27 | 313 |
| QR turbo | 680 | 27 | 653 |
| Grid safe | 165 | 27 | 138 |
| Grid normal | 553 | 27 | 526 |
| Grid turbo | 1117 | 27 | 1090 |

**Resolved (approved):** `fileName` is capped at **44 bytes**, `mimeType` at
**32 bytes** — both already reflected in the field table above and in
`src/protocol/types.ts`'s `MAX_FILE_NAME_BYTES`/`MAX_MIME_TYPE_BYTES`.

With the corrected arithmetic (§4), worst case is **133 bytes including
`createdAt`, 129 without** — QR-safe's 133-byte budget fits the full worst
case, including a timestamp, with **exactly zero bytes of slack**. Every
other channel/preset fits with comfortable room. This is tighter than ideal
(a single future field addition of any size would no longer fit QR-safe's
worst case without also dropping `createdAt`), but it is not a defect:
`createdAt` is explicitly optional and informative-only, so a sender packing
a long file name onto QR-safe can simply omit it, regaining 4 bytes. This
trade-off is recorded here rather than silently tightened further, since 44
bytes is the approved number.

44 UTF-8 bytes is short for some real filenames (long descriptive names,
non-Latin scripts using multi-byte characters) but the UI can still show the
*original*, untruncated name locally on the sender side (it's the sender's
own file, read via `File.name` — nothing about local display requires
shrinking it) — only the **wire-transmitted** name is capped. A truncated
received name is still clearly better than the alternative (silently
refusing to fit the manifest on the smallest channel, or introducing
manifest fragmentation a whole milestone early). This asymmetry (full name
shown while composing, possibly-truncated name shown after receipt) should
be called out in the UI copy once implemented.

---

## 6. Decisions (approved) and what's still genuinely open

Items 2, 3, 5, and 6 below were proposed in an earlier draft of this document
and have since been **approved as written** — kept here as a record of the
decision and its rationale, not as something still pending. Item 1 stays a
low-stakes observation. Item 4 (ESLint) is resolved separately, by deferral
— see the note after the list.

1. **`protocolVersion` byte vs. relying purely on the 2-byte magic.** Kept
   both because a magic bump for every version increment forces every prior
   receiver to add a new magic-comparison branch, whereas a single
   `magic == 0x4C53` check plus a version-number `switch` is the more
   conventional and slightly cheaper pattern once v3/v4 exist. Low-stakes,
   noted for awareness rather than because it's contentious.

2. **`transferId` at 16 bytes (128 bit) — approved.** This is 16 of the 27
   `CommonFrameHeader` bytes — the single largest field in the header by
   far. On QR-safe (160-byte capacity), a Data frame's 38-byte total
   overhead is ~24% of the frame before any payload; at 8 bytes instead of
   16 it would have been ~19%. Approved at the full 128 bits anyway, per the
   plan's explicit "mindestens 128 Bit" — spec compliance over the last few
   bytes of QR-safe payload. Implemented as `TRANSFER_ID_BYTES = 16` in
   `src/protocol/types.ts`.

3. **`CompressionAlgorithm` naming — approved.** Wire value `1 = deflate`
   (i.e. `deflate-raw`, matching the already-shipped `core/protocol.ts`
   implementation), not the plan's literal `"gzip"` sketch. Real gzip adds a
   10-byte header + 8-byte trailer per compressed unit for zero benefit here
   (both ends are always this same app; no interop requirement with
   external gzip tooling exists). Implemented as `CompressionAlgorithm =
   'none' | 'deflate'` in `src/protocol/types.ts`.

4. **ESLint — resolved: deferred, not bundled into this PR.** Introducing it
   now would mean either (a) configuring it to cover only the new
   `src/protocol/` files, which is a strange, easy-to-forget carve-out that
   doesn't actually deliver on the plan's repo-wide "Linter erfolgreich
   ist" Definition-of-Done line, or (b) configuring it repo-wide, which
   forces fixing first-time lint findings across every existing channel/UI
   file — a scope explosion for a PR whose whole premise is "protocol types
   and serialization only, zero behavioural change." Deferred to its own
   small, dedicated PR instead. Recorded here so the DoD gap is explicit
   rather than silently ignored: **this PR's `tsc --noEmit` + `vitest run`
   + `vite build` are the actual checks that ran; no lint step exists yet
   to run.**

5. **`fileName` cap: 44 bytes — approved.** See §5's corrected capacity
   arithmetic: 44 bytes (plus a 32-byte `mimeType` cap) makes the worst-case
   manifest fit exactly inside QR-safe's budget, including an optional
   `createdAt`. Implemented as `MAX_FILE_NAME_BYTES = 44` /
   `MAX_MIME_TYPE_BYTES = 32` in `src/protocol/types.ts`.

6. **`MAX_TRANSFER_BYTES` at 256 MiB — approved**, still unbenchmarked (see
   §6 in `architecture-audit.md`'s open assumptions — block-size profiles and
   real multi-block throughput are Milestone 2/6 territory, not this PR's).
   Implemented as `MAX_TRANSFER_BYTES = 256 * 1024 * 1024` in
   `src/protocol/types.ts`.

6. **Maximum transfer size (`MAX_TRANSFER_BYTES`)**: proposed **256 MiB**
   as a generous but concrete ceiling — well above the README's own
   "realistically a few hundred KB, a 5 MB photo takes minutes" honesty
   note, but bounded enough that `originalSize`/`encodedSize` (uint32,
   4 GiB ceiling) and `blockCount` (uint16, 65,535 blocks) can't be pushed
   into pathological territory: even at the smallest proposed block profile
   (256 KiB), 256 MiB ⇒ 1,024 blocks, comfortably inside the `uint16` range
   with headroom for smaller block sizes too, down to about 4 KiB blocks
   before `blockCount` would overflow `uint16` at this ceiling. This number
   is a proposal for discussion, not a measured/benchmarked limit — no
   actual multi-block transfer has been benchmarked yet (that's Milestone 2
   territory).
