import { mulberry32 } from './rng';

/**
 * Luby-Transform fountain code — the reason Light Spark needs no back channel.
 *
 * The sender emits an endless stream of "drops", each one the XOR of a randomly
 * chosen subset of the file's chunks. Any sufficiently large collection of drops
 * reconstructs the file, so the receiver may start filming late, look away, or
 * lose frames to glare without anyone having to ask for a retransmission. Sender
 * and receiver never talk; they only have to agree on this RNG.
 *
 * Expect to need roughly 5-15% more drops than there are chunks.
 */

const SOLITON_C = 0.1;
const SOLITON_DELTA = 0.5;

const cdfCache = new Map<number, Float64Array>();

/**
 * Robust soliton distribution over degrees 1..K, as a cumulative table.
 * The spike of degree-1 drops seeds the peeling decoder; the 1/(d(d-1)) tail keeps
 * the average degree low enough that decoding stays cheap.
 */
function solitonCdf(k: number): Float64Array {
  const cached = cdfCache.get(k);
  if (cached) return cached;

  const weights = new Float64Array(k + 1);
  weights[1] = 1 / k;
  for (let d = 2; d <= k; d++) weights[d] = 1 / (d * (d - 1));

  const r = SOLITON_C * Math.log(k / SOLITON_DELTA) * Math.sqrt(k);
  const spike = Math.max(1, Math.round(k / r));
  for (let d = 1; d < spike; d++) weights[d] += r / (d * k);
  if (spike <= k) weights[spike] += (r * Math.log(r / SOLITON_DELTA)) / k;

  let total = 0;
  for (let d = 1; d <= k; d++) total += weights[d];

  const cdf = new Float64Array(k + 1);
  let running = 0;
  for (let d = 1; d <= k; d++) {
    running += weights[d] / total;
    cdf[d] = running;
  }
  cdf[k] = 1;

  cdfCache.set(k, cdf);
  return cdf;
}

/**
 * Which chunks this drop is the XOR of. Derived purely from the seed, so the
 * receiver recovers the same set from the 4 seed bytes in the packet header.
 *
 * Seeds below the chunk count are *systematic*: the drop is that chunk verbatim,
 * not a combination. Senders start at seed 0, so the first pass is the plain file
 * and a receiver already watching collects it with almost no overhead — pure LT
 * coding needs about 35% more frames than there are chunks. Anyone joining later
 * simply lands in the coded region and pays the usual overhead.
 */
export function pickIndices(seed: number, k: number): number[] {
  if (k <= 1) return [0];
  if (seed < k) return [seed];

  const rand = mulberry32(seed);

  const cdf = solitonCdf(k);
  const roll = rand();
  let degree = k;
  for (let d = 1; d <= k; d++) {
    if (roll <= cdf[d]) {
      degree = d;
      break;
    }
  }

  // Partial Fisher-Yates over a virtual 0..k-1 array. The Map holds only the
  // entries actually swapped, so this stays O(degree) instead of O(k).
  const swapped = new Map<number, number>();
  const at = (i: number) => swapped.get(i) ?? i;
  const indices: number[] = [];
  for (let j = 0; j < degree; j++) {
    const pick = j + Math.floor(rand() * (k - j));
    indices.push(at(pick));
    swapped.set(pick, at(j));
  }
  return indices;
}

export function xorInto(target: Uint8Array, source: Uint8Array): void {
  for (let i = 0; i < target.length; i++) target[i] ^= source[i];
}

export class FountainEncoder {
  readonly chunkCount: number;
  private readonly chunks: Uint8Array[];
  private nextSeed: number;

  /** Starts at 0 so the systematic pass goes out first; see `pickIndices`. */
  constructor(
    readonly data: Uint8Array,
    readonly chunkSize: number,
    seedBase = 0,
  ) {
    this.chunkCount = Math.max(1, Math.ceil(data.length / chunkSize));
    this.chunks = [];
    for (let i = 0; i < this.chunkCount; i++) {
      const chunk = new Uint8Array(chunkSize);
      chunk.set(data.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, data.length)));
      this.chunks.push(chunk);
    }
    this.nextSeed = seedBase >>> 0;
  }

  /** One more drop from the endless stream. */
  next(): { seed: number; payload: Uint8Array } {
    const seed = this.nextSeed;
    this.nextSeed = (this.nextSeed + 1) >>> 0;

    const payload = new Uint8Array(this.chunkSize);
    for (const index of pickIndices(seed, this.chunkCount)) xorInto(payload, this.chunks[index]);
    return { seed, payload };
  }
}

interface PendingDrop {
  indices: Set<number>;
  data: Uint8Array;
}

export class FountainDecoder {
  readonly chunkCount: number;
  private readonly chunks: (Uint8Array | null)[];
  private readonly pending: (PendingDrop | null)[] = [];
  /** chunk index -> slots in `pending` that still depend on it */
  private readonly dependents = new Map<number, Set<number>>();
  private readonly seenSeeds = new Set<number>();
  private recovered = 0;

  constructor(
    readonly totalBytes: number,
    readonly chunkSize: number,
  ) {
    this.chunkCount = Math.max(1, Math.ceil(totalBytes / chunkSize));
    this.chunks = new Array(this.chunkCount).fill(null);
  }

  get recoveredCount(): number {
    return this.recovered;
  }

  get isComplete(): boolean {
    return this.recovered >= this.chunkCount;
  }

  /** 0..1, for the progress grid in the UI. */
  get progress(): number {
    return this.recovered / this.chunkCount;
  }

  /** Which chunks are still missing — drives the "filling up" visual. */
  get knownMask(): boolean[] {
    return this.chunks.map((c) => c !== null);
  }

  addDrop(seed: number, payload: Uint8Array): void {
    if (this.isComplete || this.seenSeeds.has(seed)) return;
    this.seenSeeds.add(seed);

    const data = new Uint8Array(this.chunkSize);
    data.set(payload.subarray(0, this.chunkSize));

    const unknown = new Set<number>();
    for (const index of pickIndices(seed, this.chunkCount)) {
      const known = this.chunks[index];
      if (known) xorInto(data, known);
      else unknown.add(index);
    }
    this.absorb({ indices: unknown, data });
  }

  /** Peeling: solve every drop this one unblocks, then everything those unblock. */
  private absorb(first: PendingDrop): void {
    const queue: PendingDrop[] = [first];

    while (queue.length > 0) {
      const drop = queue.pop()!;
      if (drop.indices.size === 0) continue;

      if (drop.indices.size > 1) {
        const slot = this.pending.length;
        this.pending.push(drop);
        for (const index of drop.indices) {
          let set = this.dependents.get(index);
          if (!set) this.dependents.set(index, (set = new Set()));
          set.add(slot);
        }
        continue;
      }

      const index = drop.indices.values().next().value!;
      if (this.chunks[index]) continue;
      this.chunks[index] = drop.data;
      this.recovered++;

      const waiting = this.dependents.get(index);
      if (!waiting) continue;
      this.dependents.delete(index);
      for (const slot of waiting) {
        const other = this.pending[slot];
        if (!other) continue;
        xorInto(other.data, drop.data);
        other.indices.delete(index);
        if (other.indices.size <= 1) {
          this.pending[slot] = null;
          for (const stale of other.indices) this.dependents.get(stale)?.delete(slot);
          queue.push(other);
        }
      }
    }
  }

  /** The reassembled payload, or null while chunks are still missing. */
  getData(): Uint8Array | null {
    if (!this.isComplete) return null;
    const out = new Uint8Array(this.totalBytes);
    for (let i = 0; i < this.chunkCount; i++) {
      const chunk = this.chunks[i]!;
      const offset = i * this.chunkSize;
      out.set(chunk.subarray(0, Math.min(this.chunkSize, this.totalBytes - offset)), offset);
    }
    return out;
  }
}
