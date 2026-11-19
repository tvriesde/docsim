/**
 * HDBSCAN (Campello et al. 2013) for small/medium point sets (O(n^2) time, O(n) memory), Euclidean distance.
 * Steps: core distances -> MST over mutual reachability (Prim) -> single-linkage tree -> condensed tree ->
 * excess-of-mass cluster selection. Mirrors the reference implementation with allow_single_cluster=false.
 */
export interface HdbscanOptions {
  minClusterSize: number;
  minSamples?: number;
}

export interface HdbscanResult {
  /** Cluster label per point (0..k-1, ordered by cluster size desc), -1 for noise. */
  labels: Int32Array;
  clusterCount: number;
}

function sqDist(data: Float64Array, dim: number, a: number, b: number): number {
  let s = 0;
  const oa = a * dim;
  const ob = b * dim;
  for (let k = 0; k < dim; k++) {
    const d = data[oa + k] - data[ob + k];
    s += d * d;
  }
  return s;
}

/** Distance to the k-th nearest other point (k = minSamples - 1; the point itself counts as the first sample). */
function coreDistances(data: Float64Array, n: number, dim: number, minSamples: number): Float64Array {
  const k = Math.min(Math.max(minSamples - 1, 0), n - 1);
  const core = new Float64Array(n);
  if (k === 0) return core;
  const heap = new Float64Array(k); // max-heap of the k smallest squared distances
  for (let i = 0; i < n; i++) {
    let size = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const d = sqDist(data, dim, i, j);
      if (size < k) {
        let c = size++;
        heap[c] = d;
        while (c > 0) {
          const p = (c - 1) >> 1;
          if (heap[p] >= heap[c]) break;
          [heap[p], heap[c]] = [heap[c], heap[p]];
          c = p;
        }
      } else if (d < heap[0]) {
        heap[0] = d;
        let c = 0;
        for (;;) {
          const l = 2 * c + 1;
          const r = l + 1;
          let m = c;
          if (l < size && heap[l] > heap[m]) m = l;
          if (r < size && heap[r] > heap[m]) m = r;
          if (m === c) break;
          [heap[m], heap[c]] = [heap[c], heap[m]];
          c = m;
        }
      }
    }
    core[i] = Math.sqrt(heap[0]);
  }
  return core;
}

interface Edge {
  a: number;
  b: number;
  w: number;
}

function mutualReachabilityMst(data: Float64Array, n: number, dim: number, core: Float64Array): Edge[] {
  const inTree = new Uint8Array(n);
  const best = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const from = new Int32Array(n).fill(-1);
  const edges: Edge[] = [];
  let current = 0;
  inTree[0] = 1;
  for (let step = 1; step < n; step++) {
    let next = -1;
    let nextW = Number.POSITIVE_INFINITY;
    for (let j = 0; j < n; j++) {
      if (inTree[j]) continue;
      const mr = Math.max(Math.sqrt(sqDist(data, dim, current, j)), core[current], core[j]);
      if (mr < best[j]) {
        best[j] = mr;
        from[j] = current;
      }
      if (best[j] < nextW) {
        nextW = best[j];
        next = j;
      }
    }
    inTree[next] = 1;
    edges.push({ a: from[next], b: next, w: nextW });
    current = next;
  }
  return edges.sort((x, y) => x.w - y.w);
}

interface CondensedEdge {
  parent: number;
  child: number;
  lambda: number;
  size: number;
}

export function hdbscan(points: number[][], options: HdbscanOptions): HdbscanResult {
  const n = points.length;
  const minClusterSize = Math.max(2, options.minClusterSize);
  const minSamples = Math.max(1, options.minSamples ?? minClusterSize);
  const labels = new Int32Array(n).fill(-1);
  if (n < minClusterSize || n < 2) return { labels, clusterCount: 0 };
  const dim = points[0].length;
  const data = new Float64Array(n * dim);
  points.forEach((p, i) => data.set(p, i * dim));

  // Single-linkage tree: leaves 0..n-1, internal nodes n..2n-2 (root = 2n-2).
  const core = coreDistances(data, n, dim, minSamples);
  const mst = mutualReachabilityMst(data, n, dim, core);
  const total = 2 * n - 1;
  const left = new Int32Array(total).fill(-1);
  const right = new Int32Array(total).fill(-1);
  const dist = new Float64Array(total);
  const size = new Int32Array(total).fill(1);
  const uf = new Int32Array(total);
  for (let i = 0; i < total; i++) uf[i] = i;
  const find = (x: number): number => {
    while (uf[x] !== x) {
      uf[x] = uf[uf[x]];
      x = uf[x];
    }
    return x;
  };
  mst.forEach((e, idx) => {
    const node = n + idx;
    const ra = find(e.a);
    const rb = find(e.b);
    left[node] = ra;
    right[node] = rb;
    dist[node] = e.w;
    size[node] = size[ra] + size[rb];
    uf[ra] = node;
    uf[rb] = node;
  });
  const root = total - 1;

  const leavesOf = (node: number): number[] => {
    const out: number[] = [];
    const stack = [node];
    while (stack.length) {
      const x = stack.pop()!;
      if (x < n) out.push(x);
      else stack.push(left[x], right[x]);
    }
    return out;
  };

  // Condensed tree. Cluster ids: 0 = root, assigned in creation order (children > parents).
  const condensed: CondensedEdge[] = [];
  const clusterOf = new Int32Array(total).fill(-1);
  clusterOf[root] = 0;
  let nextCluster = 1;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node < n) continue;
    const parentCluster = clusterOf[node];
    const lambda = dist[node] > 0 ? 1 / dist[node] : Number.POSITIVE_INFINITY;
    const l = left[node];
    const r = right[node];
    const lBig = size[l] >= minClusterSize;
    const rBig = size[r] >= minClusterSize;
    if (lBig && rBig) {
      for (const c of [l, r]) {
        clusterOf[c] = nextCluster++;
        condensed.push({ parent: parentCluster, child: clusterOf[c], lambda, size: size[c] });
        stack.push(c);
      }
    } else {
      for (const [c, big] of [
        [l, lBig],
        [r, rBig],
      ] as const) {
        if (big) {
          clusterOf[c] = parentCluster;
          stack.push(c);
        } else {
          for (const p of leavesOf(c)) condensed.push({ parent: parentCluster, child: -(p + 1), lambda, size: 1 });
        }
      }
    }
  }

  const clusterCount = nextCluster;
  const birth = new Float64Array(clusterCount);
  const parentOf = new Int32Array(clusterCount).fill(-1);
  const children: number[][] = Array.from({ length: clusterCount }, () => []);
  for (const e of condensed) {
    if (e.child >= 0) {
      birth[e.child] = e.lambda;
      parentOf[e.child] = e.parent;
      children[e.parent].push(e.child);
    }
  }
  const stability = new Float64Array(clusterCount);
  for (const e of condensed) {
    const lam = Number.isFinite(e.lambda) ? e.lambda : birth[e.parent];
    stability[e.parent] += (lam - birth[e.parent]) * e.size;
  }

  // Excess of mass: children before parents (ids increase with depth); the root is never selected.
  const selected = new Uint8Array(clusterCount);
  const subtreeStability = Float64Array.from(stability);
  for (let c = clusterCount - 1; c >= 1; c--) {
    const childSum = children[c].reduce((s, ch) => s + subtreeStability[ch], 0);
    if (children[c].length && childSum > stability[c]) {
      subtreeStability[c] = childSum;
    } else {
      selected[c] = 1;
      const desc = [...children[c]];
      while (desc.length) {
        const d = desc.pop()!;
        selected[d] = 0;
        desc.push(...children[d]);
      }
    }
  }

  // Each point belongs to the nearest selected ancestor of the cluster it fell out of.
  const raw = new Int32Array(n).fill(-1);
  for (const e of condensed) {
    if (e.child >= 0) continue;
    let c = e.parent;
    while (c > 0 && !selected[c]) c = parentOf[c];
    raw[-e.child - 1] = c > 0 && selected[c] ? c : -1;
  }

  const sizes = new Map<number, number>();
  raw.forEach((c) => c >= 0 && sizes.set(c, (sizes.get(c) ?? 0) + 1));
  const order = [...sizes.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const remap = new Map(order.map((c, i) => [c, i]));
  raw.forEach((c, i) => (labels[i] = c >= 0 ? remap.get(c)! : -1));
  return { labels, clusterCount: order.length };
}
