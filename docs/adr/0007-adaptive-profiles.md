# ADR 0007: Adaptive profile recommendation — local-only hysteresis, calibration scoring deferred from its interactive workflow

*(Numbering note: the roadmap didn't pre-assign a number to this topic — its
suggested list only went up to `0006` (worker-boundaries, still upcoming).
This continues the sequential numbering already established by 0004/0005/0006's
own renumbering notes.)*

## Status

Accepted and implemented (`src/channels/profile.ts`,
`src/channels/qualityMetrics.ts`, `src/channels/profileRecommender.ts`,
`src/channels/calibration.ts`).

## Context

Milestone 6 asks for three related but separable things: a profile model,
real (non-FPS-estimated) quality metrics, and profile-switch logic with
hysteresis — plus an optional pre-transfer calibration benchmark. The
roadmap itself already scopes the automation question down: "Zunächst nur
lokale Empfehlung ... Später automatisierbar über optischen Rückkanal" —
i.e. Milestone 6 is explicitly receiver-local advice, not sender-driven
automatic switching (that needs Milestone 10's feedback channel, not yet
built, same as noted throughout this initiative).

## Decisions

### 1. Profiles derived from existing presets, not invented

`SPARK_GRID_PROFILES` and `QR_PROFILES` (`profile.ts`) are built directly
from `GRID_PRESETS`/`QR_PRESETS` — every numeric field is cross-checked
against its source preset in `profile.test.ts` rather than hand-copied, so
the two can't silently drift apart. `tileColumns`/`tileRows`
(Milestone 5's tiling, PR 4) and `calibrationInterval`/`fullMarkerInterval`
(Milestone 7, not yet built) are left `undefined` in every starting
profile — there is no measured data yet to derive real numbers from either,
and the roadmap's own "nicht willkürlich fest verdrahten" instruction
applies just as much to leaving a field unset with a documented reason as
it does to the fields that do have values.

### 2. Quality metrics are real counters plus an injectable clock, never `targetFps`

`QualityWindow` (`qualityMetrics.ts`) only increments counters on actual
events (a frame captured, something detected, a CRC that passed or failed)
and computes `effectivePayloadBytesPerSecond` from real elapsed time via an
injectable `now()` — defaulting to `Date.now`, replaceable with a fake
clock in tests. This is what makes `profile.test.ts`'s hysteresis tests
deterministic: a test can advance a fake clock by an exact number of
milliseconds instead of needing real `setTimeout` delays or tolerating
timing flakiness.

### 3. Hysteresis: asymmetric thresholds, a minimum-samples floor, an overload guard

`ProfileRecommender` (`profileRecommender.ts`) implements the roadmap's
four explicit hysteresis requirements literally:

- **"nach mehreren schlechten Messfenstern"** → `minBadWindowsBeforeRobust`,
  default **2**.
- **"erst nach längerer stabiler Qualität"** → `minGoodWindowsBeforeDenser`,
  default **5** — deliberately higher than the bad-side threshold, matching
  the roadmap's own asymmetric framing (recover quickly, upgrade
  cautiously).
- **"Mindestdauer pro Profil"** → `minDurationMsPerProfile`, default
  **10 000 ms**, gating any switch regardless of streak state (streaks
  still accumulate during the cooldown, so a real problem noticed early
  isn't wasted — the switch itself simply can't fire until the cooldown
  clears).
- **"manueller Override bleibt möglich"** → `overrideProfile()`, which also
  resets all hysteresis state, so a user's explicit choice isn't
  immediately second-guessed by streak counters left over from before they
  intervened (tested directly in `profile.test.ts`).

Two additional, undocumented-by-the-roadmap-but-necessary details:

- **`minSamplesPerWindow`** (default 5): a window with too few detected
  frames is too noisy to trust and is ignored — counted toward neither
  streak, but also doesn't reset one already building. Without this, a
  single sparse window (e.g. the very first one, before the receiver has
  locked onto anything) could inject noise into what's otherwise a
  clean signal.
- **A middling hit rate** (between the bad and good thresholds) also
  extends neither streak, for the same reason: one so-so window shouldn't
  erase several consecutive clearly-good or clearly-bad ones.

All five numeric defaults (2, 5, 10 000 ms, and the 0.5/0.9 hit-rate
thresholds) are initial, reasoned proposals, explicitly **not** benchmarked
against real capture data — matching `architecture-audit.md`'s open
assumption about `BLOCK_PROFILES` in spirit: a concrete, defensible
starting point, not a measured constant. Real-world tuning needs an actual
sender/receiver pair in the field, which doesn't exist yet in this codebase
(no channel is wired to Protocol v2 at all — see every prior PR's "not yet
wired in" note).

### 4. "Überlastete Geräte" check, computed against the *current* profile's own budget

Before ever recommending `'denser'`, the recommender compares the window's
measured `processingTimeMs` against `1000 / currentProfile.targetFps` — the
frame budget the device has actually been measured operating under, not the
budget of the *candidate* denser profile (which would be circular: you
can't yet know how long processing at a profile takes before switching to
it). A device already failing to keep up with its current profile never
gets recommended something more demanding, directly satisfying Milestone
9.5's explicit acceptance criterion.

### 5. Calibration: scoring implemented, the interactive workflow deferred

`calibration.ts`'s `selectBestProfile` implements the *decision* half of
Milestone 6.4 ("robustestes Profil oberhalb einer Qualitätsgrenze wählen")
as a pure function over already-collected `(profile, metrics)` pairs. The
*collection* half — a sender cycling through profiles showing known test
patterns, synchronized with a receiver that's measuring each one — is
deferred, because it fundamentally needs one of two things this codebase
doesn't have yet: a real feedback channel (Milestone 10) to coordinate
"which profile is on screen right now", or a bespoke fixed timing schedule
invented just for this purpose. The latter was rejected specifically
because it would likely be thrown away once Milestone 10's real
coordination mechanism exists — better to defer than to build (and then
migrate away from) a one-off synchronization scheme.

## Consequences

- Every piece of this PR is pure logic with no camera, canvas, or DOM
  dependency — `qualityMetrics.ts` and `profileRecommender.ts` are as
  usable from a future Web Worker (Milestone 9) as from a main-thread UI.
- Nothing in this PR is wired into `GridBeamSource`/`GridReceiver`,
  `QrBeamSource`/`QrReceiver`, or any UI screen — same pattern as every
  prior PR in this initiative. In particular, no code anywhere yet calls
  `QualityWindow`'s `record*` methods from a real detection loop; that
  wiring, and the decision of how large a "window" should be in practice
  (frame count? wall-clock interval?), is left to whoever does that
  integration.
- The profile ordering (`SPARK_GRID_PROFILES`/`QR_PROFILES` arrays, robust
  to dense) is load-bearing for `ProfileRecommender` — reordering either
  array would silently invert "more robust" and "denser". Documented in
  `profile.ts`'s own comment, not just here.

## Alternatives considered

- **Deriving `effectivePayloadBytesPerSecond` from `capturedFrames ×
  bytesPerFrame × targetFps`** (i.e. a nominal estimate). Rejected
  outright — this is exactly the "keine der Metriken darf allein auf
  geschätzter Display-Framerate beruhen" the roadmap explicitly forbids.
- **A single symmetric hysteresis threshold** (same window count for both
  directions). Rejected in favour of the roadmap's own explicit asymmetry
  (recover fast, upgrade slow) — a symmetric design would have been
  simpler but contradicts the stated requirement.
- **Building the full interactive calibration handshake now**, against a
  temporary/invented synchronization scheme. Rejected — see decision 5
  above.
