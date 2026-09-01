# ADR 0002: Protocol v2 magic byte and version field, coexisting with v1

## Status

Accepted and implemented (`src/protocol/types.ts`, `src/protocol/frameHeader.ts`).

## Context

v1 has two independent wire formats already: the fountain-drop packet
(`core/packet.ts`, single-byte magic `0xA7`, no version field at all) and the
envelope (`core/protocol.ts`, 4-byte magic `"LSPK"`, single version byte
fixed at `1`, `parseEnvelope` rejects anything else outright). Neither format
has ever needed to change, so neither has had to answer: how does a receiver
that understands *both* an old and a new format tell them apart, frame by
frame, without ambiguity — and how does a future v3 avoid the same problem
recurring?

Protocol v2 (block transfer, manifest, resumability) needs to be introduced
**without breaking v1**: existing QR/Grid senders and receivers (including
anyone who hasn't updated yet, or a future rollback) must keep working
unmodified.

## Decision

1. **A new, distinct magic value for v2**: `0x4C53` ("LS"), 2 bytes, at the
   very start of `CommonFrameHeader`. This cannot collide with v1's
   `packet.ts` format, whose first byte must be `0xA7` — a v2 magic's first
   byte (`0x4C`) is never `0xA7`, so a v1 decoder rejects a v2 frame
   immediately (wrong magic byte) and a v2 decoder rejects a v1 frame
   immediately (wrong first two bytes), with no shared prefix to reason
   about.
2. **A separate `protocolVersion` byte** (currently always `2`), *in
   addition to* the magic. Rationale: a magic-byte bump for every future
   protocol revision would force every prior receiver to grow a new
   magic-comparison branch per version. A single `magic == 0x4C53` check
   followed by a `protocolVersion` `switch`/dispatch is the more
   conventional pattern once v3, v4, etc. exist — the magic says "this is a
   Light Spark v2-family frame", the version says which exact revision.
   (Recorded as a low-stakes, non-contentious choice in
   `docs/protocol-v2.md` §6 item 1 — the alternative, versioning purely via
   the magic bytes, was viable too.)
3. **Unknown `protocolVersion` → reject outright**, never attempt to guess
   at a newer or older layout. A hypothetical v3 decoder is expected to
   special-case v2 explicitly if backward compatibility is wanted, not
   assume it for free.
4. **Unknown `frameType` → reject outright**, same reasoning — frame types
   are not designed to be a forward-compatible extension point.
5. **Unknown/reserved `flags` bits → ignored, not rejected.** This is the
   *actual* forward-compatible extension point: a future addition that
   doesn't need to change any existing field's layout can be introduced as a
   new flag bit, safely ignorable by an older v2.0 decoder. A change that
   *does* need a new layout requires a `protocolVersion` bump instead —
   flags never change what bytes mean, only add optional, ignorable
   behavior hints (e.g. `FLAG_SYSTEMATIC`).

## Consequences

- v1 and v2 receivers can coexist in the same codebase, trying v2 decode
  first and falling back to v1 decode, per frame, with zero ambiguity and no
  shared-prefix edge cases to special-case.
- `core/packet.ts` and `core/protocol.ts` require **no changes at all** to
  support this — the whole compatibility story lives on the v2 side.
- A future v3 has a clear, precedented path: bump `PROTOCOL_VERSION`, keep
  the `0x4C53` magic (still "a Light Spark v2-family-and-beyond frame"), and
  a v2-and-v3-aware decoder dispatches on the version byte. If v3 ever needs
  a wire-incompatible framing change so large that even *that* doesn't work,
  a new magic is still available as an escape hatch — this decision doesn't
  foreclose it, it just isn't the default extension mechanism.
- Cost: 3 bytes (2-byte magic + 1-byte version) that a single 1-byte magic
  alone wouldn't need. Judged worth it for the dispatch simplicity described
  above, and small relative to `CommonFrameHeader`'s other costs (chiefly
  the 16-byte `transferId`, see `docs/protocol-v2.md` §6 item 2).

## Alternatives considered

- **Extend v1's packet magic with a sub-version byte.** Rejected: v1's
  `decodePacket` has no version field and no room reserved for one without
  changing `PACKET_HEADER_SIZE`, which would itself be a breaking change to
  the format this ADR is trying to avoid breaking.
- **Single-byte v2 magic instead of 2 bytes.** Considered, rejected: the
  entire available single-byte space isn't actually scarce, but picking a
  single byte guaranteed to never collide with v1's `0xA7`, various QR/Grid
  frame-body leading bytes, or any future format is harder to reason about
  convincingly than a 2-byte value chosen to also read as recognizable ASCII
  ("LS"). The extra byte's cost is negligible against `transferId`'s 16
  bytes.
