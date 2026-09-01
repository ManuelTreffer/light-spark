# Architecture Audit

Status: **first deliverable of the Protocol v2 initiative — no code changed.** This
document is the full inventory the implementation work is planned against. It
covers the codebase as of `main` (commit range through the "Security hardening"
and "Cloudflare wrangler fix" PRs), before any Protocol v2 code exists.

Companion document: [`protocol-v2.md`](./protocol-v2.md) (wire format proposal).

---

## 1. Stack and tooling

| Concern | Current state |
|---|---|
| Framework | Preact 10 (`preact/hooks`), JSX via `jsxImportSource: preact` |
| Build | Vite 7, `@preact/preset-vite` |
| Language | TypeScript 5.9, `strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noEmit` (Vite does the actual transpile) |
| Module system | ESNext modules, `moduleResolution: bundler`, `isolatedModules: true` |
| Tests | Vitest 3, **`environment: 'node'`** (not jsdom/browser) — camera/canvas-dependent code is tested via hand-written fakes, not a real DOM |
| PWA | `vite-plugin-pwa`, `registerType: 'autoUpdate'`, `generateSW` mode |
| Deploy | Cloudflare Workers static assets (`wrangler.toml` → `[assets] directory = "./dist"`) |
| Linting | **None.** No ESLint config, no `lint` script in `package.json`. `npm run build` runs `tsc --noEmit && vite build`; that's the only static check today. |
| Property-based testing | Not installed (no `fast-check` or similar) |
| Web Workers | Not used anywhere |
| Persistence | Not used anywhere — no `localStorage`, `sessionStorage`, or IndexedDB in `src/` |
| External network calls | None — confirmed via full-repo search for `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` |
| Total source size | ~3,900 lines across `src/**/*.{ts,tsx}` (including tests) |

**Implication for the plan:** IndexedDB (Milestone 4), Web Workers (Milestone 9),
and any lint-gated "Definition of Done" step are all **greenfield** — there's
nothing existing to migrate, but also no established project convention to
follow. Decisions there need to be made fresh (see §6 Open Questions in
`protocol-v2.md` and the ADRs).

---

## 2. Directory structure (current)

```text
src/
  app.tsx                    Root component: tab switch between Send/Receive
  main.tsx                   Preact render() entry point
  styles.css                 Global styles

  core/
    protocol.ts               Envelope format (LSPK): name/mime/data + CRC-32, gzip-less deflate-raw compression
    packet.ts                 Fountain-drop wire packet (magic/streamId/totalBytes/chunkSize/seed + payload)
    fountain.ts                FountainEncoder/FountainDecoder, robust-soliton pickIndices, deterministic via mulberry32
    rng.ts                     mulberry32 deterministic PRNG
    crc32.ts                   CRC-32 (IEEE) + CRC-8 (poly 0x07, for Beacon)
    assembler.ts                TransferAssembler: turns decoded packets into a ReceivedPayload
    base45.ts                   RFC 9285 Base45 codec (QR channel only)
    *.test.ts                   Unit tests for the above

  channels/
    types.ts                    ChannelId, BeamSource/ChannelReceiver interfaces, CHANNELS metadata, recommendChannel()
    estimate.ts                  Per-channel transfer time estimate
    channels.test.ts             Cross-channel unit tests

    qr/
      sender.ts                  QrBeamSource: fountain → packet → base45 → QR render
      receiver.ts                 QrReceiver: BarcodeDetector (native) or jsQR fallback → base45 decode → packet bytes
      loopback.test.ts            Renders real QR, re-decodes with jsQR, exercises fountain reassembly with loss

    grid/
      spec.ts                     GridPalette (4/8 colour), geometry math, GRID_PRESETS (safe/normal/turbo)
      codec.ts                     encodeGridCells/decodeGridCells: frame body ↔ per-cell colour indices, CRC-32-protected
      render.ts                    Canvas paint: markers, calibration rows, data cells
      detect.ts                    Marker blob detection, homography-based cell sampling, colour classification, quality metric
      homography.ts                4-point projective transform solver (Gaussian elimination)
      sender.ts                    GridBeamSource: fountain → packet → encodeGridCells → renderGrid
      receiver.ts                  GridReceiver: tries all 3 presets until one passes CRC, then locks
      loopback.test.ts             Simulated camera (perspective/blur/noise/exposure/white-balance) round-trip

    beacon/                       DISABLED in the UI (commented out, not deleted) — own tiny protocol, unrelated to packet.ts
      codec.ts                     Differential 8-colour step encoding, CRC-8, whole-message-in-one-frame (no fountain code)
      sender.ts                    BeaconBeamSource
      receiver.ts                  BeaconReceiver

  ui/
    SendView.tsx / ReceiveView.tsx  Screens; own all transfer state (useState), no state management library
    BeamStage.tsx                   Fullscreen canvas render loop (requestAnimationFrame) for sending
    useCamera.ts                    getUserMedia + capture loop + useWakeLock
    PayloadPreview.tsx               Post-receive preview, download, trust-model hints
```

There is no `app/`, `protocol/` (as a folder — `core/` plays that role today),
`transfer/`, `integrity/`, `compression/`, `vision/`, `storage/`, or `workers/`
directory yet. All of Milestones 1–9's target folders are new.

---

## 3. Data flow — Sender (current, v1)

```
SendView.tsx
  │  user picks text or File
  ▼
payloadFromText() / payloadFromFile()          (core/protocol.ts)
  │  → { name, mime, data: Uint8Array }
  ▼
buildEnvelope(payload)                          (core/protocol.ts, async)
  │  • encodes name/mime as UTF-8, truncated to 200/120 bytes
  │  • tries CompressionStream('deflate-raw'); keeps compressed body only if smaller
  │  • builds one 18-byte header + name + mime + body, with a CRC-32 over the
  │    *original* (uncompressed) data
  ▼
Uint8Array envelope  (this is the thing that actually gets fountain-coded)
  │
  ├─ chosen === 'qr'   → new QrBeamSource(envelope, preset)
  ├─ chosen === 'grid' → new GridBeamSource(envelope, preset)
  └─ chosen === 'beacon' → DISABLED (dead branch, commented out)

QrBeamSource / GridBeamSource constructor
  │  new FountainEncoder(envelope, chunkSize)   (core/fountain.ts)
  │  chunkCount = ceil(envelope.length / chunkSize)
  ▼
BeamStage.tsx drives a requestAnimationFrame loop at `preset.fps`
  │  each tick calls beamSource.renderFrame(ctx, w, h)
  ▼
renderFrame():
  1. encoder.next() → { seed, payload }        (systematic first pass: seed < chunkCount
                                                  ⇒ payload IS chunk[seed] verbatim;
                                                  seed ≥ chunkCount ⇒ XOR of a soliton-
                                                  distributed random subset)
  2. encodePacket({ streamId, totalBytes: envelope.length, chunkSize, seed, payload })
     → 13-byte header + payload                  (core/packet.ts)
  3. QR:   base45Encode(packet) → QRCode.create() → draw black/white modules
     Grid: encodeGridCells(packet, spec) → renderGrid() paints markers +
           calibration rows + data cells, packet wrapped in its own CRC-32
  4. loop forever — sender has no idea if/when the receiver is done
```

Key property: **the sender never stops or adapts.** There is no feedback
channel, no acknowledgement, no concept of "this receiver already has file X".
Every restart of the send screen picks a new random `streamId`
(`Math.floor(Math.random() * 0xffff)` — not cryptographically relevant, purely
a session discriminator) and starts the systematic pass over.

---

## 4. Data flow — Receiver (current, v1)

```
ReceiveView.tsx
  │  user picks channel ('qr' | 'grid'; 'beacon' UI entry is disabled)
  ▼
new TransferAssembler(setState, setResult)       (core/assembler.ts)
new QrReceiver(...) / GridReceiver(...)           (per-channel)
  │
useCamera(receiver, active)                       (ui/useCamera.ts)
  │  getUserMedia → requestAnimationFrame loop
  │  each tick: draw video frame into an offscreen canvas sized to
  │  `receiver.preferredWidth`, build a CameraFrame, call receiver.ingest(frame)
  │  — ticks are serialised (`busy` flag): a slow ingest just skips frames,
  │  there is no queue and nothing is buffered
  ▼
QrReceiver.ingest(frame)                          GridReceiver.ingest(frame)
  │ BarcodeDetector or jsQR → text                 │ tries each of the 3 GRID_PRESETS
  │ base45Decode(text) → bytes                     │ (or the already-locked one) until
  │ onPacket(bytes)                                │ detectGrid() + decodeGridCells()
  ▼                                                │ both succeed (CRC-checked)
  └──────────────────► onPacket(body) ◄────────────┘
                            │
                            ▼
              assembler.ingestPacket(bytes)         (core/assembler.ts)
                │  decodePacket(bytes)               (core/packet.ts)
                │    • checks magic byte, length ≥ header+chunkSize
                │    • rejects totalBytes/chunkSize combinations whose implied
                │      chunkCount exceeds MAX_CHUNK_COUNT, or totalBytes > MAX_TOTAL_BYTES
                │      (16 MiB) — added in the recent security-hardening PR
                │  if streamId changed ⇒ new FountainDecoder(totalBytes, chunkSize),
                │    discarding any in-progress decode
                │  decoder.addDrop(seed, payload)     (core/fountain.ts)
                │    • pickIndices(seed, chunkCount) — deterministic, mulberry32-based
                │    • XORs the drop into a pending-equation graph; peels every
                │      drop this resolves, cascading
                │  if decoder.isComplete → finish(decoder.getData())
                ▼
              parseEnvelope(envelope bytes)          (core/protocol.ts)
                │  validates magic/version, decodes name (sanitizeName strips
                │  Unicode bidi-control chars), mime, inflates if compressed,
                │  checks CRC-32 over the decompressed data
                ▼
              ReceivedPayload { name, mime, data, verified }
                ▼
              PayloadPreview.tsx — inline preview, download, "unverified
              source" hints (checksum ≠ authenticity)
```

Key property: **the whole file is one Fountain-code graph.** There is no
concept of a block. `FountainDecoder` allocates `chunks = new Array(chunkCount)`
for the *entire file* up front (bounded today only by the 16 MiB /
200,000-chunk caps — a blunt, whole-transfer limit, not a per-block one). A
receiver that starts mid-transfer, loses the connection, or reloads the page
loses 100% of decode progress: nothing is persisted, and `TransferAssembler`
lives entirely in React/Preact component state.

---

## 5. Current wire formats (v1) — reference for what Protocol v2 must stay
compatible alongside

### 5.1 Fountain packet (`core/packet.ts`) — carried by QR and Spark Grid

Big-endian throughout (`DataView` calls all pass `littleEndian=false`).

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | magic | `0xA7`, fixed |
| 1 | 2 | streamId | `Math.random()`-derived, changes = new transfer |
| 3 | 4 | totalBytes | length of the *envelope* (not the original file) being sent; validated ≤ `MAX_TOTAL_BYTES` (16 MiB) |
| 7 | 2 | chunkSize | validated: `ceil(totalBytes / chunkSize) ≤ MAX_CHUNK_COUNT` (200,000) |
| 9 | 4 | seed | drop's PRNG seed; `seed < chunkCount` ⇒ systematic (chunk `seed` verbatim) |
| 13 | chunkSize | payload | the drop itself |

No versioning field. No CRC on the packet header itself — QR relies on the
QR symbol's own Reed-Solomon error correction; Grid wraps the whole packet
(header + payload) inside its own CRC-32 (see §5.3). A garbled QR read that
still parses as a plausible packet (right magic byte, plausible lengths) has
**no packet-level integrity check** — only the *envelope's* CRC-32, checked
once the whole file is reassembled, would catch it. This is an accepted
trade-off in v1 (documented in `README.md`'s "Checksums on two levels"), but
worth being explicit about here: a corrupted-but-plausible QR packet can
poison one Fountain equation, which the peeling decoder currently has no way
to isolate — it doesn't verify per-drop integrity, only whole-file integrity
at the end.

### 5.2 Envelope (`core/protocol.ts`, magic `"LSPK"`) — what actually gets
Fountain-coded

Big-endian.

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 4 | magic | `"LSPK"` (0x4C 0x53 0x50 0x4B) |
| 4 | 1 | version | `1`, fixed — `parseEnvelope` rejects anything else |
| 5 | 1 | flags | bit 0 = compressed (`deflate-raw` via `CompressionStream`, **not gzip**) |
| 6 | 2 | nameLen | |
| 8 | 2 | mimeLen | |
| 10 | 4 | dataLen | length of the *original, uncompressed* data |
| 14 | 4 | crc32 | CRC-32 over the *original, uncompressed* data |
| 18 | nameLen | name | UTF-8; on receive, run through `sanitizeName()` (strips bidi-control chars) |
| 18+nameLen | mimeLen | mime | UTF-8 |
| 18+nameLen+mimeLen | rest | body | raw or deflate-raw-compressed data |

### 5.3 Spark Grid frame body (`channels/grid/codec.ts`)

```
[4 bytes: CRC-32 of everything after it][packet bytes][zero padding to capacityBytes]
```

`capacityBytes = floor(cellCount * bitsPerCell / 8)`, cell-count and
bits-per-cell coming from the locked `GridSpec` (`GRID_PRESETS`). This CRC is
what makes Grid's per-frame integrity story stronger than QR's — see §5.1.

### 5.4 Beacon frame (`channels/beacon/codec.ts`) — **separate protocol**,
not built on `packet.ts` at all

Differential 8-colour step stream: `colour[i] = (colour[i-1] + step) mod 8`,
`step ∈ {1,2,3,4}` carries 2 bits, `step 5` is a frame delimiter, 6/7 unused.
One frame: `[delimiter][length byte][payload bytes][CRC-8 byte]`, each byte
split into 4 dibits. Whole message must fit in ≤255 bytes (`MAX_BEACON_BYTES`).
No Fountain code — the whole (tiny) message loops as one unit. **This channel
is currently disabled in the UI**, but the module is intact.

### 5.5 Capacity table (chunk payload bytes available to `packet.ts`, per
existing preset — computed from `spec.ts`/`sender.ts`, not previously written
down anywhere)

| Channel | Preset | fps | Chunk payload (bytes) | Packet total (header+payload) |
|---|---|---|---|---|
| QR | safe (EC=M) | 8 | 160 | 173 |
| QR | normal (EC=L) | 10 | 340 | 353 |
| QR | turbo (EC=L) | 12 | 680 | 693 |
| Grid | safe (28×28, 4 colours) | 8 | 165 | 178 |
| Grid | normal (40×40, 8 colours) | 10 | 553 | 566 |
| Grid | turbo (56×56, 8 colours) | 12 | 1117 | 1130 |
| Beacon (disabled) | — | 5/8/10 | ≤255 total message, no per-frame chunking | n/a |

This table is the load-bearing input for every Protocol v2 field-width
decision in `protocol-v2.md` §2 — the new `CommonFrameHeader` has to fit
*inside* the smallest of these (QR safe, 160 bytes) with room left for an
actual payload.

---

## 6. Dependencies

| Package | Role | Notes for the plan |
|---|---|---|
| `preact` | UI runtime | Milestone 1's "no DOM dependencies in codec/protocol modules" rule matters because `core/` and `channels/*/codec.ts` today are already Preact-free — that discipline just needs to continue, not be introduced |
| `qrcode` | QR symbol generation (sender) | Used only in `channels/qr/sender.ts` |
| `jsqr` | QR decoding fallback (iOS Safari, or wherever `BarcodeDetector` is unavailable/throws) | `channels/qr/receiver.ts` |
| `vite-plugin-pwa` | Service worker + manifest generation | Build-time only |
| `@vitejs/plugin-basic-ssl` | Dev-only HTTPS for `npm run dev:host -- --https` | Never in the production bundle |
| Native `CompressionStream`/`DecompressionStream` | deflate-raw compression | No fallback library; if unsupported, `buildEnvelope` just sends uncompressed (try/catch) |
| Native `BarcodeDetector` | Hardware QR decode where available | Falls back to `jsqr` |
| Native `getUserMedia`, `WakeLock`, Canvas 2D | Camera/render pipeline | No polyfills |

No cryptography library is in use (no `SubtleCrypto`, no third-party crypto).
CRC-32/CRC-8 are hand-rolled but are checksums, not cryptographic primitives —
consistent with the plan's "no crypto self-implementations" rule, since
neither is being used *as* a security mechanism, only as data-integrity
detection. **SHA-256 is not implemented anywhere today.** The Web Crypto API
(`crypto.subtle.digest('SHA-256', ...)`) is available in every browser this
app already targets (secure-context requirement is already true for camera
access) and is the obvious, plan-compliant ("no crypto self-implementations")
choice for Milestone 8's file/block hashing — this should not be hand-rolled.

---

## 7. Known technical risks

Ranked roughly by how much they constrain the Protocol v2 design, not by
exploitability.

1. **Whole-file-as-one-Fountain-graph is the central architectural limit.**
   Everything in Milestones 2–4 (blocks, resume, bounded memory) exists to
   remove this. `FountainDecoder` currently has no concept of "give up on
   this equation and free it" short of completing the whole file — see §4.

2. **No persistence layer exists at all.** Milestone 4 is not a migration,
   it's new construction. Decision needed up front: what IndexedDB schema,
   what exactly gets persisted (the plan already scopes this down sensibly —
   verified blocks only, for v1 of Resume).

3. **No Web Worker infrastructure exists.** Vision (marker detection +
   homography + colour classification), Fountain decoding, and (future)
   SHA-256/compression all currently run on the main thread inside
   `useCamera`'s `requestAnimationFrame` tick. This mostly works today
   because chunk sizes are small and grids top out at 56×56 cells, but it's
   exactly the kind of thing that stops scaling once blocks, tiles, and
   larger grids are layered on. Vite supports `new Worker(new
   URL('./x.ts', import.meta.url), { type: 'module' })` natively — no extra
   bundler config needed, but no code exists yet to build on.

4. **No lint tooling.** The plan's Definition of Done says "Linter
   erfolgreich ist" for every PR. Today there is nothing to run. This needs
   an explicit decision (introduce ESLint now, as part of PR 1's tooling
   groundwork, or defer and drop that DoD line for the first few PRs) —
   flagged as an open question in `protocol-v2.md`.

5. **`FountainEncoder`/`FountainDecoder` are already reasonably solid** and
   match Milestone 3's requirements closely: deterministic seed→chunk-index
   selection (`mulberry32`, no `Math.random()` in the codec path), a real
   systematic phase (`seed < chunkCount` ⇒ verbatim chunk), degree-1 peeling
   with cascading resolution. Milestone 3's guidance to "kapseln und
   optimieren, statt neu schreiben" is very achievable — the main gap is
   **decoder protection limits** (§6.4 of the plan: max droplet count, max
   degree, max unresolved-equation count) which don't exist yet at the
   Fountain layer (only the packet-header-level `MAX_TOTAL_BYTES` /
   `MAX_CHUNK_COUNT` caps exist, added for the DoS fix — those bound the
   *decoder's initial allocation*, not its ongoing equation-graph growth
   under a flood of high-degree drops).

6. **QR has no per-packet integrity check independent of the QR symbol's own
   error correction** (§5.1). Any future block/tile CRC design should not
   assume "QR passed decode ⇒ packet bytes are trustworthy" without a
   dedicated frame-level CRC, matching what Grid already does.

7. **`streamId` (16-bit) is not fit to become `transferId`.** It is
   `Math.random() * 0xffff`, i.e. ~16 bits of non-cryptographic randomness,
   generated fresh per `BeamSource` construction. Protocol v2's 128-bit
   `transferId` is a different thing with a different purpose (multi-transfer
   disambiguation for Resume, §7 of the plan) and needs its own generation
   path — likely `crypto.getRandomValues`, still with no cryptographic
   *requirement* attached (it's an identifier, not a secret).

8. **Existing test infrastructure is Node-only (no DOM).** Grid and QR
   loopback tests build hand-written fakes for exactly the DOM surface they
   need (`fakeCanvas`, a raw `ImageData`-shaped object). New tile/fragment
   tests (Milestone 5) and any new vision code should follow this same
   pattern rather than pulling in `jsdom` — it's proven to work and keeps
   tests fast (the whole suite runs in ~6s today including two full
   simulated-camera loopback suites).

9. **Manifest field budgets are tight against real QR/Grid frame capacities**
   (see `protocol-v2.md` §5 for the arithmetic) — this is flagged as an open
   question rather than silently decided, because it directly trades off
   against filename/MIME-type length in the UI.

10. **No maximum transfer size is currently enforced at the manifest/file
    level** (only the packet-header DoS caps exist, which bound a single
    Fountain graph, not a whole multi-block transfer). Milestone 1's
    `TransferManifest.originalSize`/`encodedSize` fields need an explicit,
    documented ceiling — proposed in `protocol-v2.md`.

---

## 8. Proposed target architecture

Section headings below map directly onto the plan's §2 folder list; each one
notes what's genuinely new vs. what's a rename/regroup of existing code.

```
src/
  app/            NEW — SenderSession/ReceiverSession orchestration (Milestone 2)
                  currently: this logic is inline in SendView.tsx/ReceiveView.tsx

  protocol/       NEW module boundary — currently core/protocol.ts + core/packet.ts
                  combined; v2 formally separates "envelope/manifest" from
                  "wire frame" as the plan's CommonFrameHeader/DataFrameHeader
                  split requires. v1 code stays in core/ untouched (rollback path).

  transfer/       NEW — BlockPlan, SenderSession, ReceiverSession, resume
                  handling, progress calculation. No prior art in the repo.

  fountain/       RENAME/PROMOTE from core/fountain.ts + core/rng.ts.
                  Encoder/decoder logic ports close to 1:1; new: decoder
                  protection limits (Milestone 3.4), block-scoped decoders
                  (Milestone 2) instead of one file-wide decoder.

  integrity/      RENAME/PROMOTE from core/crc32.ts. NEW: SHA-256 wrapper
                  (Web Crypto's crypto.subtle.digest — no self-implementation).

  compression/    RENAME/PROMOTE from the deflate/inflate helpers currently
                  inline in core/protocol.ts, generalised behind the plan's
                  `Compressor` interface. Naming caveat: the plan's type says
                  `CompressionAlgorithm = "none" | "gzip"`, but the existing
                  (and recommended-to-keep) implementation is `deflate-raw`,
                  not gzip — see protocol-v2.md open question.

  channels/       KEPT AS-IS structurally. beacon/qr/spark-grid subfolders
                  already exist and already match the plan's target layout.
                  qr/ and grid/ internals (spec, codec, render, detect,
                  homography, sender, receiver) are functionally complete for
                  v1 and mostly reusable for v2 — v2 changes are additive
                  (new frame types, tiling later) not replacements.

  vision/         RENAME/PROMOTE from channels/grid/{detect,homography}.ts +
                  ui/useCamera.ts's capture logic. Currently vision code is
                  grid-specific; if a future channel needs similar geometry
                  handling this is where it'd be shared. Not urgent to move
                  before Milestone 5 (tiles) actually needs it.

  storage/        NEW — no prior art. TransferRepository over IndexedDB
                  (Milestone 4).

  workers/        NEW — no prior art (see Risk #3).

  ui/             KEPT structurally. SendView/ReceiveView will need real
                  rework as SenderSession/ReceiverSession absorb their state
                  management (currently ~10 useState hooks each), but the
                  presentational components (BeamStage, PayloadPreview,
                  useCamera's camera-lifecycle half) stay largely as-is.
```

**Deliberately not restructured yet:** this audit does not move a single file.
Per the plan's own instructions ("Wichtig: noch keine große Umstrukturierung
durchführen, bevor diese Analyse abgeschlossen ist" / "Ersetze funktionierende
bestehende Komponenten nicht ohne messbaren oder strukturell notwendigen
Grund"), PR 1 (next) only *adds* `protocol/` types and serialization
alongside the existing `core/`, with zero behavioural change to the shipping
v1 channels. Physical file moves (e.g. `core/fountain.ts` → `fountain/`)
should happen only when a milestone's PR actually needs the new module
boundary to exist, each as its own small, reviewable commit — not as a
big-bang rename.

---

## 9. File → module mapping

| Existing file | Status under Protocol v2 | Target module |
|---|---|---|
| `core/protocol.ts` | Kept, untouched (v1 envelope, still used by v1-tagged transfers) | stays in `core/` |
| `core/packet.ts` | Kept, untouched (v1 fountain-drop wire format) | stays in `core/` |
| `core/fountain.ts` | Reused/extended: block-scoped decoder instances, new protection limits | `fountain/` (new home, once Milestone 2/3 lands) |
| `core/rng.ts` | Reused as-is — this is exactly the deterministic PRNG Milestone 3 asks for | `fountain/` |
| `core/crc32.ts` | Reused as-is; SHA-256 added alongside, not replacing it | `integrity/` |
| `core/assembler.ts` | Superseded in *concept* by `ReceiverSession` (Milestone 2), but the v1 code stays for v1-tagged transfers | `core/` (v1) + new `transfer/` (v2) |
| `core/base45.ts` | Kept as-is — QR-specific, orthogonal to the block/manifest work | stays in `channels/qr/` conceptually, currently in `core/` (fine either way) |
| `channels/types.ts` | Extended, not replaced: `ChannelId`, `BeamSource`, `ChannelReceiver` are still the right shape; profile/quality-metric types (Milestone 6) get added here or in a new `channels/profile.ts` | `channels/` |
| `channels/estimate.ts` | Reused; will need a v2-aware variant once block-based transfers change what "how long will this take" means | `channels/` |
| `channels/qr/*`, `channels/grid/*` | Reused, additive changes only for v2 (new frame types layered in, no rewrite) | stays |
| `channels/beacon/*` | Untouched, stays disabled; out of scope for the whole Protocol v2 initiative (it has its own tiny format, no block/fountain concept applies) | stays |
| `ui/SendView.tsx`, `ui/ReceiveView.tsx` | Heavy rework eventually (state moves into `SenderSession`/`ReceiverSession`), but **not in PR 1** | `ui/` (thinner, later) |
| `ui/BeamStage.tsx`, `ui/PayloadPreview.tsx`, `ui/useCamera.ts` | Reused; `useCamera`'s capture loop is a candidate for the eventual `workers/` vision worker, not urgent | `ui/` (mostly), `vision/`+`workers/` (later) |

No file is deleted or rewritten wholesale in this pass — this table is the
map for *later* milestones, recorded now so each future PR can point back to
"this was flagged in the audit" instead of re-litigating placement.

---

## 10. PR 1 plan (next step, not yet started)

Scope, per the plan's own Milestone 1 and its explicit "erste Lieferung"
phasing — **types and binary (de)serialization only, zero behavioural change
to any shipping channel:**

1. `src/protocol/` (new folder): `TransferManifest`, `FrameType`,
   `CommonFrameHeader`, `DataFrameHeader` as TypeScript interfaces/enums,
   matching `protocol-v2.md`'s field tables exactly.
2. Binary serializers/deserializers for the manifest and both header shapes
   (`encodeManifest`/`decodeManifest`, `encodeFrameHeader`/`decodeFrameHeader`
   or similar), written the same way `core/packet.ts` already is: explicit
   `DataView` offsets, no JSON, no `any`.
3. Validation at every deserialize boundary *before* any allocation —
   unknown `protocolVersion` → reject; declared `payloadLength` exceeding the
   actual remaining bytes → reject; `blockCount`/`sourceChunkSize` beyond
   documented maxima → reject. This directly extends the pattern already
   shipped in `core/packet.ts`'s `MAX_TOTAL_BYTES`/`MAX_CHUNK_COUNT` checks.
4. Golden-vector tests: hand-computed byte sequences for (a) a minimal valid
   manifest, (b) a minimal valid data frame header, (c) each documented
   rejection case (bad magic, bad version, truncated buffer, oversized
   declared length) — as literal `Uint8Array` fixtures, not just
   round-trip-through-the-encoder tests, so a future accidental wire-format
   change gets caught even if encoder and decoder change in lockstep by
   mistake.
5. `docs/protocol-v2.md` finalized against whatever falls out of implementing
   #1–4 (the field widths in the current draft are a proposal; if reality
   forces a change, the doc gets updated in the same PR, not after).
6. `docs/adr/0001-block-based-transfer.md` and
   `docs/adr/0002-protocol-versioning.md` — recording the block-transfer
   rationale and the magic-byte/version-field co-existence strategy with v1
   (§3 of `protocol-v2.md`).
7. Explicitly **not** in PR 1: no change to `SendView`/`ReceiveView`, no new
   `FrameType` actually being sent over any channel, no `SenderSession`/
   `ReceiverSession`, no block splitting. The new protocol module exists and
   is fully tested but is not wired into anything yet — that's PR 2.

Definition of done for PR 1, concretely: `npx tsc --noEmit` clean,
`npx vitest run` green (existing 59 tests + new protocol tests, no existing
test touched or skipped), `npm run build` succeeds, and — since no channel's
runtime behaviour changes — a manual smoke check that Send/Receive still work
end-to-end is a formality, not a real risk, but worth doing once anyway.

---

## 11. Open assumptions (need a decision before PR 1 is implemented)

These are called out in detail with proposed defaults in `protocol-v2.md` §6;
listed here for visibility:

1. **`transferId` width.** Plan text says "mindestens 128 Bit". At 26 bytes
   of `CommonFrameHeader` per frame already (see `protocol-v2.md` §2 for the
   full breakdown), a 16-byte transfer ID is a third of that header on its
   own. Proposal: keep the full 128 bits as specified (correctness/spec
   compliance over the last few bytes of QR-safe payload) — but this is
   exactly the kind of trade-off worth confirming rather than assuming.
2. **Manifest field caps** (`fileName`, `mimeType` max lengths) — tight
   against QR-safe's 160-byte frame capacity once wrapped in a 26-byte
   common header. See the worked arithmetic in `protocol-v2.md` §5.
3. **`CompressionAlgorithm` naming**: plan says `"gzip"`, existing (and
   recommended) implementation is `deflate-raw`. Proposal: rename the type's
   value to `"deflate"` to match reality, rather than switching the actual
   compression to real gzip (which adds ~18 bytes of header/footer overhead
   for zero benefit in this always-both-ends-are-this-app scenario).
4. **ESLint**: introduce now (as part of PR 1's tooling) or defer? No
   existing convention to preserve either way.
5. **Block size profiles**: the plan's suggested `small/balanced/large`
   (256 KiB/1 MiB/4 MiB) aren't yet benchmarked against this app's actual
   channels (QR/Grid transfer effective payload is on the order of 1–17
   KB/s depending on preset — see the README's speed table). A 4 MiB block
   at Grid-safe's ~1.3 KB/s would take over 50 minutes just for one block's
   systematic pass. Needs revisiting once real block-transfer benchmarking
   exists (Milestone 2/6) — flagged, not decided, here.
6. **Maximum total transfer size** the manifest is allowed to declare — no
   number exists yet; proposed in `protocol-v2.md` §4.
