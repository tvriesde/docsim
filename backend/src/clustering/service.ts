import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { FastifyBaseLogger } from 'fastify';
import type { AiService } from '../ai/types.js';
import { distinctiveKeywords, truncate } from '../lib/text.js';
import { mapLimit, nowIso } from '../lib/util.js';
import type { LayoutRow, Store } from '../store/store.js';
import { CORPUS, type ClusterInfo, type ClusterRun } from '../types.js';
import { computeLayout, type LayoutParams, type LayoutResult } from './layout.js';

const REPRESENTATIVES = 8;

/** Runs the CPU-heavy layout in a worker thread so the API stays responsive; falls back to inline. */
function runLayout(vectors: number[][], overrides: Partial<LayoutParams>, log: FastifyBaseLogger): Promise<LayoutResult> {
  const workerFile = ['worker.js', 'worker.ts']
    .map((f) => fileURLToPath(new URL(`./${f}`, import.meta.url)))
    .find((f) => existsSync(f));
  if (!workerFile || workerFile.endsWith('.ts')) {
    return Promise.resolve(computeLayout(vectors, overrides));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile);
    worker.once('message', (msg: { ok: boolean; result?: LayoutResult; error?: string }) => {
      void worker.terminate();
      if (msg.ok) resolve(msg.result!);
      else reject(new Error(msg.error));
    });
    worker.once('error', (err: Error) => {
      log.warn({ err: err.message }, 'layout worker failed; computing inline');
      void worker.terminate();
      try {
        resolve(computeLayout(vectors, overrides));
      } catch (e) {
        reject(e);
      }
    });
    worker.postMessage({ vectors, overrides });
  });
}

export class ClusterService {
  private current?: Promise<ClusterRun>;
  private timer?: NodeJS.Timeout;

  constructor(
    private store: Store,
    private ai: AiService,
    private log: FastifyBaseLogger,
    private debounceMs: number,
  ) {}

  get running(): boolean {
    return this.current !== undefined;
  }

  /** Debounced automatic recompute (after an ingestion batch drains). */
  schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.current) {
        void this.current.finally(() => this.schedule());
        return;
      }
      this.run('auto').catch((err) => this.log.error({ err }, 'automatic recluster failed'));
    }, this.debounceMs);
  }

  /** Starts a run unless one is in progress; returns the in-progress or new run. */
  async start(trigger: ClusterRun['trigger'], overrides: Partial<LayoutParams> = {}): Promise<ClusterRun> {
    if (this.current) return (await this.store.latestClusterRun())!;
    const run = this.newRun(trigger, overrides);
    await this.store.saveClusterRun(run);
    this.current = this.execute(run, overrides).finally(() => (this.current = undefined));
    this.current.catch(() => undefined);
    return run;
  }

  async run(trigger: ClusterRun['trigger'], overrides: Partial<LayoutParams> = {}): Promise<ClusterRun> {
    await this.start(trigger, overrides);
    return (await this.current) ?? (await this.store.latestClusterRun())!;
  }

  private newRun(trigger: ClusterRun['trigger'], overrides: Partial<LayoutParams>): ClusterRun {
    return {
      id: randomUUID(),
      corpus: CORPUS,
      status: 'running',
      trigger,
      createdAt: nowIso(),
      docCount: 0,
      noiseCount: 0,
      params: { minClusterSize: 0, minSamples: 0, nNeighbors: 0, ...overrides },
      clusters: [],
    };
  }

  private async execute(run: ClusterRun, overrides: Partial<LayoutParams>): Promise<ClusterRun> {
    const started = Date.now();
    try {
      const rows = await this.store.layoutRows();
      const layout = await runLayout(
        rows.map((r) => r.proj),
        overrides,
        this.log,
      );
      const clusters = await this.describeClusters(rows, layout);
      await this.store.setPositions(
        rows.map((r, i) => ({ id: r.id, x: layout.coords[i][0], y: layout.coords[i][1], clusterId: layout.labels[i] })),
      );
      Object.assign(run, {
        status: 'done',
        finishedAt: nowIso(),
        docCount: rows.length,
        noiseCount: layout.labels.filter((l) => l < 0).length,
        params: layout.params,
        clusters,
      });
      this.log.info({ docs: rows.length, clusters: clusters.length, ms: Date.now() - started }, 'clustering finished');
    } catch (err) {
      Object.assign(run, { status: 'failed', finishedAt: nowIso(), error: (err as Error).message });
      this.log.error({ err }, 'clustering failed');
    }
    await this.store.saveClusterRun(run);
    return run;
  }

  private async describeClusters(rows: LayoutRow[], layout: LayoutResult): Promise<ClusterInfo[]> {
    const texts = rows.map((r) => `${r.title ?? r.name} ${r.summary ?? ''}`);
    const ids = [...new Set(layout.labels.filter((l) => l >= 0))].sort((a, b) => a - b);
    return mapLimit(ids, 4, async (id) => {
      const members = layout.labels.flatMap((l, i) => (l === id ? [i] : []));
      const cx = members.reduce((s, i) => s + layout.coords[i][0], 0) / members.length;
      const cy = members.reduce((s, i) => s + layout.coords[i][1], 0) / members.length;
      const keywords = distinctiveKeywords(members.map((i) => texts[i]), texts);
      const reps = [...members]
        .sort(
          (a, b) =>
            Math.hypot(layout.coords[a][0] - cx, layout.coords[a][1] - cy) -
            Math.hypot(layout.coords[b][0] - cx, layout.coords[b][1] - cy),
        )
        .slice(0, REPRESENTATIVES)
        .map((i) => ({ title: rows[i].title ?? rows[i].name, summary: rows[i].summary ?? '' }));
      let label = keywords.slice(0, 3).join(', ');
      let description = '';
      try {
        const out = await this.ai.labelCluster({ keywords, docs: reps });
        if (out.label) label = out.label;
        description = out.description;
      } catch (err) {
        this.log.warn({ err: (err as Error).message, cluster: id }, 'cluster labelling failed; using keywords');
      }
      return {
        id,
        label: truncate(label, 60),
        description: truncate(description, 300),
        keywords,
        size: members.length,
        cx: Math.round(cx * 1e4) / 1e4,
        cy: Math.round(cy * 1e4) / 1e4,
      };
    });
  }
}
