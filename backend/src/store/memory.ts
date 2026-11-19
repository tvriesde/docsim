import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cosine } from '../lib/vector.js';
import type { Batch, ClusterRun, DocRecord, DocStatus, DocSummary, ListDocsQuery, MapPoint, SimilarHit } from '../types.js';
import { stripEmbedding, type LayoutRow, type PositionUpdate, type Store } from './store.js';

interface Snapshot {
  docs: DocRecord[];
  batches: Batch[];
  runs: ClusterRun[];
}

/** In-memory store persisted to a JSON file; for local development and tests. */
export class MemoryStore implements Store {
  private docs = new Map<string, DocRecord>();
  private batches = new Map<string, Batch>();
  private runs: ClusterRun[] = [];
  private saveTimer?: NodeJS.Timeout;

  constructor(private file?: string) {}

  async init(): Promise<void> {
    if (!this.file) return;
    try {
      const snap = JSON.parse(await readFile(this.file, 'utf8')) as Snapshot;
      snap.docs.forEach((d) => this.docs.set(d.id, d));
      snap.batches.forEach((b) => this.batches.set(b.id, b));
      this.runs = snap.runs;
    } catch {
      // first start
    }
  }

  private persist(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = undefined;
      const snap: Snapshot = { docs: [...this.docs.values()], batches: [...this.batches.values()], runs: this.runs };
      await mkdir(path.dirname(this.file!), { recursive: true });
      await writeFile(this.file!, JSON.stringify(snap));
    }, 500);
  }

  async createDoc(doc: DocRecord): Promise<void> {
    this.docs.set(doc.id, structuredClone(doc));
    this.persist();
  }

  async getDoc(id: string, withEmbedding = false): Promise<DocRecord | undefined> {
    const d = this.docs.get(id);
    if (!d) return undefined;
    return withEmbedding ? structuredClone(d) : (stripEmbedding(structuredClone(d)) as DocRecord);
  }

  async patchDoc(id: string, patch: Partial<DocRecord>): Promise<void> {
    const d = this.docs.get(id);
    if (!d) return;
    Object.assign(d, structuredClone(patch));
    this.persist();
  }

  async deleteDoc(id: string): Promise<void> {
    this.docs.delete(id);
    this.persist();
  }

  async listDocs(q: ListDocsQuery): Promise<{ items: DocSummary[]; total: number }> {
    const needle = q.q?.toLowerCase();
    const all = [...this.docs.values()]
      .filter((d) => !q.status || d.status === q.status)
      .filter((d) => q.clusterId === undefined || (d.clusterId ?? -1) === q.clusterId)
      .filter((d) => !q.batchId || d.batchId === q.batchId)
      .filter((d) => !needle || d.name.toLowerCase().includes(needle) || (d.title ?? '').toLowerCase().includes(needle))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items: all.slice(q.offset, q.offset + q.limit).map(stripEmbedding), total: all.length };
  }

  async countByStatus(): Promise<Partial<Record<DocStatus, number>>> {
    const out: Partial<Record<DocStatus, number>> = {};
    for (const d of this.docs.values()) out[d.status] = (out[d.status] ?? 0) + 1;
    return out;
  }

  async idsByStatus(statuses: DocStatus[]): Promise<string[]> {
    return [...this.docs.values()].filter((d) => statuses.includes(d.status)).map((d) => d.id);
  }

  async batchStatuses(batchId: string): Promise<DocStatus[]> {
    return [...this.docs.values()].filter((d) => d.batchId === batchId).map((d) => d.status);
  }

  async layoutRows(): Promise<LayoutRow[]> {
    return [...this.docs.values()]
      .filter((d) => d.status === 'ready' && d.proj)
      .map((d) => ({ id: d.id, name: d.name, title: d.title, summary: d.summary, proj: d.proj! }));
  }

  async embeddingsFor(ids: string[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    for (const id of ids) {
      const e = this.docs.get(id)?.embedding;
      if (e) out.set(id, e);
    }
    return out;
  }

  async mapPoints(): Promise<MapPoint[]> {
    return [...this.docs.values()]
      .filter((d) => d.status === 'ready' && typeof d.x === 'number' && typeof d.y === 'number')
      .map((d) => ({ id: d.id, name: d.name, title: d.title, x: d.x!, y: d.y!, clusterId: d.clusterId ?? -1 }));
  }

  async similar(embedding: number[], k: number, excludeId: string): Promise<SimilarHit[]> {
    return [...this.docs.values()]
      .filter((d) => d.status === 'ready' && d.embedding && d.id !== excludeId)
      .map((d) => ({ doc: stripEmbedding(d), score: cosine(embedding, d.embedding!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  async setPositions(updates: PositionUpdate[]): Promise<void> {
    for (const u of updates) {
      const d = this.docs.get(u.id);
      if (d) Object.assign(d, { x: u.x, y: u.y, clusterId: u.clusterId });
    }
    this.persist();
  }

  async createBatch(batch: Batch): Promise<void> {
    this.batches.set(batch.id, batch);
    this.persist();
  }

  async getBatch(id: string): Promise<Batch | undefined> {
    return this.batches.get(id);
  }

  async listBatches(limit: number): Promise<Batch[]> {
    return [...this.batches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  async saveClusterRun(run: ClusterRun): Promise<void> {
    this.runs = [...this.runs.filter((r) => r.id !== run.id), structuredClone(run)].slice(-20);
    this.persist();
  }

  async latestClusterRun(onlyDone = false): Promise<ClusterRun | undefined> {
    return [...this.runs]
      .filter((r) => !onlyDone || r.status === 'done')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }
}
