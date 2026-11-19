import { UMAP } from 'umap-js';
import { seededRandom } from '../lib/vector.js';
import { hdbscan } from './hdbscan.js';

export interface LayoutParams {
  minClusterSize: number;
  minSamples: number;
  nNeighbors: number;
}

export interface LayoutResult {
  coords: [number, number][];
  labels: number[];
  params: LayoutParams;
}

/** Defaults scale with corpus size: ~2 for tiny demo sets, up to 25 for 10k documents. */
export function defaultParams(n: number, overrides: Partial<LayoutParams> = {}): LayoutParams {
  const minClusterSize = overrides.minClusterSize ?? (n < 30 ? 2 : Math.min(25, Math.max(3, Math.round(Math.sqrt(n) / 2))));
  return {
    minClusterSize,
    minSamples: overrides.minSamples ?? Math.max(1, Math.min(minClusterSize, Math.round(minClusterSize / 2) + 1)),
    nNeighbors: overrides.nNeighbors ?? Math.max(2, Math.min(15, n - 1)),
  };
}

function circle(n: number): [number, number][] {
  return Array.from({ length: n }, (_, i) => [Math.cos((2 * Math.PI * i) / n), Math.sin((2 * Math.PI * i) / n)]);
}

/** Rescales coordinates to roughly [-10, 10] so the frontend can use a stable zoom range. */
function rescale(coords: [number, number][]): [number, number][] {
  const xs = coords.map((c) => c[0]);
  const ys = coords.map((c) => c[1]);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
  return coords.map(([x, y]) => [round(((x - cx) / span) * 20), round(((y - cy) / span) * 20)]);
}

function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/**
 * 2D UMAP projection of (normalized) vectors for display; HDBSCAN runs on the input vectors themselves.
 * Clustering the 2D layout loses too much density structure (small topics next to a large group merge), and a
 * low-dim UMAP for clustering is seed-sensitive, so the deterministic full-dimension input is used instead.
 */
export function computeLayout(vectors: number[][], overrides: Partial<LayoutParams> = {}, seed = 42): LayoutResult {
  const n = vectors.length;
  const params = defaultParams(n, overrides);
  if (n === 0) return { coords: [], labels: [], params };
  if (n < 4) return { coords: rescale(circle(n)), labels: new Array(n).fill(-1), params };

  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: params.nNeighbors,
    minDist: 0.1,
    spread: 1,
    random: seededRandom(seed),
  });
  const embedding = umap.fit(vectors) as number[][];
  const coords = rescale(embedding.map((p) => [p[0], p[1]] as [number, number]));

  const { labels } = hdbscan(vectors, { minClusterSize: params.minClusterSize, minSamples: params.minSamples });
  return { coords, labels: Array.from(labels), params };
}
