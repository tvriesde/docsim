import { normalize, seededRandom } from './vector.js';

export const PROJ_DIMS = 256;
const SEED = 20240611;

let cached: { dims: number; matrix: Float32Array } | undefined;

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function matrixFor(dims: number): Float32Array {
  if (cached?.dims === dims) return cached.matrix;
  const rand = seededRandom(SEED);
  const m = new Float32Array(dims * PROJ_DIMS);
  for (let i = 0; i < m.length; i++) m[i] = gaussian(rand);
  cached = { dims, matrix: m };
  return m;
}

/**
 * Fixed Gaussian random projection (Johnson-Lindenstrauss) of a normalized embedding into PROJ_DIMS dims,
 * re-normalized and rounded. Cosine structure is approximately preserved, which is all the 2D layout needs,
 * and it keeps the clustering read path small. The seed is fixed so projections stay comparable over time.
 */
export function projectEmbedding(embedding: number[]): number[] {
  if (embedding.length <= PROJ_DIMS) return normalize(embedding).map(round);
  const m = matrixFor(embedding.length);
  const out = new Array<number>(PROJ_DIMS).fill(0);
  for (let i = 0; i < embedding.length; i++) {
    const v = embedding[i];
    if (v === 0) continue;
    const row = i * PROJ_DIMS;
    for (let j = 0; j < PROJ_DIMS; j++) out[j] += v * m[row + j];
  }
  return normalize(out).map(round);
}

function round(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}
