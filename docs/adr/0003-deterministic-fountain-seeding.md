# ADR 0003: Reuse v1's systematic-seed convention instead of a separate `dropletIndex` field

## Status

Accepted and implemented (`src/protocol/frameHeader.ts`'s `isSystematic`,
cross-checked against `core/fountain.ts`'s `pickIndices` in
`src/protocol/protocol.test.ts`).

## Context

The roadmap's `DataFrameHeader` sketch includes an optional field:

```ts
interface DataFrameHeader {
  blockIndex: number;
  blockSourceChunkCount: number;
  dropletSeed: number;
  dropletDegree: number;
  dropletIndex?: number;
}
```

`dropletIndex` would identify *which* source chunk a systematic (verbatim,
non-combinatorial) drop carries. But v1's existing Fountain implementation
already has an equivalent concept, and it's load-bearing: in
`core/fountain.ts`'s `pickIndices(seed, k)`,

```ts
if (k <= 1) return [0];
if (seed < k) return [seed];
```

— any seed less than the chunk count `k` is *defined* to mean "this drop is
exactly source chunk `seed`, verbatim". `FountainEncoder` relies on this: it
starts its `nextSeed` counter at 0 specifically so the first `chunkCount`
drops it emits are the systematic pass (`core/fountain.ts`'s
`FountainEncoder` doc comment; confirmed by the existing test "emits the
plain chunks first" in `src/core/core.test.ts`). A receiver never has to be
told separately which chunk a systematic drop is — it's `pickIndices`'s
first argument, already present as `dropletSeed`.

## Decision

**No separate `dropletIndex` wire field.** `DataFrameHeader` in
`src/protocol/types.ts` omits it entirely. The convention is:

```
dropletSeed < blockSourceChunkCount  ⇒  this drop IS source chunk `dropletSeed`, verbatim
```

exactly mirroring `pickIndices`'s existing `seed < k` branch — implemented
identically for v2 blocks (`isSystematic` in `frameHeader.ts`, and
`decodeDataFrameHeader` rejects a header that claims `dropletDegree !== 1`
for a systematic seed, since a systematic drop's degree is fixed at 1 by
construction and any other claimed value is self-contradictory).

`CommonFrameHeader.flags`'s `FLAG_SYSTEMATIC` bit (`docs/protocol-v2.md` §2)
is set on these frames anyway — **not** because a receiver needs it to
determine systematic-ness (it can always recompute that from `dropletSeed`
vs. `blockSourceChunkCount`), but purely as a cheap fast-path hint: a
receiver that trusts the flag can skip the `pickIndices` PRNG call entirely
and use `dropletSeed` directly as the chunk index. A receiver that ignores
the flag (or a future implementation that doesn't bother with the
fast path) still gets the correct answer either way, since `pickIndices`
already special-cases `seed < k` on its own. The flag is redundant with the
seed/count comparison by design — that's what makes it safe to ignore
(satisfying the "unknown/unused flags must not break anything" rule from
`docs/protocol-v2.md` §2) rather than a second source of truth that could
disagree with the first.

## Consequences

- Saves 4 bytes per Data frame (`dropletIndex` would have been a `uint32`
  like `dropletSeed`) at zero cost to correctness, since the information was
  already fully recoverable from existing fields.
- Directly ties the v2 wire format to v1's `core/fountain.ts` behavior:
  changing `pickIndices`'s systematic-seed convention in `core/fountain.ts`
  would silently break this assumption. `src/protocol/protocol.test.ts`
  has a dedicated test asserting the two stay in agreement
  (`"agrees with core/fountain.ts's pickIndices on what 'systematic' means"`)
  specifically so such a change fails loudly in `protocol/`'s test suite,
  not silently in production.
- Matches the roadmap's own Milestone 3 guidance to reuse and encapsulate
  the existing Fountain implementation rather than rebuild it — this is one
  concrete instance of doing exactly that, rather than treating v2 as a
  clean-slate redesign of the Fountain layer.

## Alternatives considered

- **Implement `dropletIndex` as specified.** Rejected: purely redundant
  with `dropletSeed` under the existing (and reused) `pickIndices`
  convention — would have added 4 bytes per frame for information already
  present, with no compatibility benefit since v2 isn't wire-compatible with
  the roadmap's sketch anyway (that sketch was explicitly logical/illustrative,
  per the roadmap's own "Die konkrete Bytebreite jedes Feldes ist nach
  Prüfung der erwarteten Maximalgrößen festzulegen").
- **Use a different seed convention for v2 blocks than v1 uses today**
  (e.g. always run every seed through the full Soliton-distribution PRNG,
  no systematic special case). Rejected: would give up the systematic pass's
  real, measured benefit (near-zero overhead for a receiver already watching
  from the start — see the existing test "costs almost nothing when the
  receiver is watching from the first frame") for no offsetting gain.
