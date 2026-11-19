export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function norm(a: ArrayLike<number>): number {
  return Math.sqrt(dot(a, a));
}

export function normalize(a: number[]): number[] {
  const n = norm(a);
  return n === 0 ? a.slice() : a.map((v) => v / n);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const d = norm(a) * norm(b);
  return d === 0 ? 0 : dot(a, b) / d;
}

/** Weighted mean of vectors, L2-normalized. Used to pool chunk embeddings into one document vector. */
export function meanPool(vectors: number[][], weights?: number[]): number[] {
  if (vectors.length === 0) throw new Error('meanPool needs at least one vector');
  const dim = vectors[0].length;
  const out = new Array<number>(dim).fill(0);
  let total = 0;
  vectors.forEach((v, i) => {
    if (v.length !== dim) throw new Error('meanPool: dimension mismatch');
    const w = weights?.[i] ?? 1;
    total += w;
    for (let j = 0; j < dim; j++) out[j] += v[j] * w;
  });
  if (total === 0) throw new Error('meanPool: weights sum to zero');
  return normalize(out.map((x) => x / total));
}

/** Deterministic PRNG (mulberry32), so layouts are reproducible. */
export function seededRandom(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
