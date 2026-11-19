import { CosmosClient, type Container, type PatchOperation, type SqlParameter } from '@azure/cosmos';
import type { TokenCredential } from '@azure/identity';
import { mapLimit } from '../lib/util.js';
import {
  CORPUS,
  type Batch,
  type ClusterRun,
  type DocRecord,
  type DocStatus,
  type DocSummary,
  type ListDocsQuery,
  type MapPoint,
  type SimilarHit,
} from '../types.js';
import type { LayoutRow, PositionUpdate, Store } from './store.js';

const SUMMARY_FIELDS = [
  'id', 'corpus', 'name', 'mime', 'size', 'blobName', 'batchId', 'uploadedBy', 'status', 'error', 'pageCount',
  'rawChars', 'bodyChars', 'removedLines', 'bodyMethod', 'title', 'summary', 'bodyPreview', 'chunkCount', 'language',
  'clusterId', 'x', 'y', 'createdAt', 'updatedAt', 'processedAt',
];
const LIST_FIELDS = SUMMARY_FIELDS.filter((f) => f !== 'bodyPreview');
const select = (fields: string[]) => fields.map((f) => `c.${f}`).join(', ');

function isNotFound(err: unknown): boolean {
  return (err as { code?: number }).code === 404;
}

/** Drops Cosmos system properties (_rid, _ts, ...). */
function clean<T extends object>(item: T): T {
  return Object.fromEntries(Object.entries(item).filter(([k]) => !k.startsWith('_'))) as T;
}

export class CosmosStore implements Store {
  private docs: Container;
  private batches: Container;
  private runs: Container;
  private pk = { partitionKey: CORPUS };

  constructor(endpoint: string, database: string, credential: TokenCredential) {
    const db = new CosmosClient({ endpoint, aadCredentials: credential }).database(database);
    this.docs = db.container('documents');
    this.batches = db.container('batches');
    this.runs = db.container('clusterRuns');
  }

  async init(): Promise<void> {
    await this.docs.read();
  }

  private async query<T>(container: Container, query: string, parameters: SqlParameter[] = []): Promise<T[]> {
    const { resources } = await container.items.query<T>({ query, parameters }, this.pk).fetchAll();
    return resources;
  }

  async createDoc(doc: DocRecord): Promise<void> {
    await this.docs.items.create(doc);
  }

  async getDoc(id: string, withEmbedding = false): Promise<DocRecord | undefined> {
    try {
      const { resource } = await this.docs.item(id, CORPUS).read<DocRecord>();
      if (!resource) return undefined;
      const doc = clean(resource);
      if (!withEmbedding) {
        delete doc.embedding;
        delete doc.proj;
      }
      return doc;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async patchDoc(id: string, patch: Partial<DocRecord>): Promise<void> {
    const ops: PatchOperation[] = Object.entries(patch).map(([k, v]) => ({
      op: 'set',
      path: `/${k}`,
      value: v === undefined ? null : v,
    }));
    try {
      // Cosmos accepts at most 10 operations per patch request.
      for (let i = 0; i < ops.length; i += 10) {
        await this.docs.item(id, CORPUS).patch(ops.slice(i, i + 10));
      }
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async deleteDoc(id: string): Promise<void> {
    try {
      await this.docs.item(id, CORPUS).delete();
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async listDocs(q: ListDocsQuery): Promise<{ items: DocSummary[]; total: number }> {
    const where: string[] = [];
    const params: SqlParameter[] = [];
    if (q.status) {
      where.push('c.status = @status');
      params.push({ name: '@status', value: q.status });
    }
    if (q.clusterId !== undefined) {
      where.push(q.clusterId === -1 ? '(NOT IS_DEFINED(c.clusterId) OR IS_NULL(c.clusterId) OR c.clusterId = -1)' : 'c.clusterId = @cid');
      params.push({ name: '@cid', value: q.clusterId });
    }
    if (q.batchId) {
      where.push('c.batchId = @batch');
      params.push({ name: '@batch', value: q.batchId });
    }
    if (q.q) {
      where.push('(CONTAINS(c.name, @q, true) OR CONTAINS(c.title, @q, true))');
      params.push({ name: '@q', value: q.q });
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [items, total] = await Promise.all([
      this.query<DocSummary>(
        this.docs,
        `SELECT ${select(LIST_FIELDS)} FROM c ${clause} ORDER BY c.createdAt DESC OFFSET @off LIMIT @lim`,
        [...params, { name: '@off', value: q.offset }, { name: '@lim', value: q.limit }],
      ),
      this.query<number>(this.docs, `SELECT VALUE COUNT(1) FROM c ${clause}`, params),
    ]);
    return { items, total: total[0] ?? 0 };
  }

  async countByStatus(): Promise<Partial<Record<DocStatus, number>>> {
    const rows = await this.query<{ status: DocStatus; n: number }>(
      this.docs,
      'SELECT c.status, COUNT(1) AS n FROM c GROUP BY c.status',
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  async idsByStatus(statuses: DocStatus[]): Promise<string[]> {
    return this.query<string>(this.docs, 'SELECT VALUE c.id FROM c WHERE ARRAY_CONTAINS(@s, c.status)', [
      { name: '@s', value: statuses },
    ]);
  }

  async batchStatuses(batchId: string): Promise<DocStatus[]> {
    return this.query<DocStatus>(this.docs, 'SELECT VALUE c.status FROM c WHERE c.batchId = @b', [
      { name: '@b', value: batchId },
    ]);
  }

  async layoutRows(): Promise<LayoutRow[]> {
    return this.query<LayoutRow>(
      this.docs,
      "SELECT c.id, c.name, c.title, c.summary, c.proj FROM c WHERE c.status = 'ready' AND IS_DEFINED(c.proj)",
    );
  }

  async embeddingsFor(ids: string[]): Promise<Map<string, number[]>> {
    if (ids.length === 0) return new Map();
    const rows = await this.query<{ id: string; embedding: number[] }>(
      this.docs,
      'SELECT c.id, c.embedding FROM c WHERE ARRAY_CONTAINS(@ids, c.id)',
      [{ name: '@ids', value: ids }],
    );
    return new Map(rows.map((r) => [r.id, r.embedding]));
  }

  async mapPoints(): Promise<MapPoint[]> {
    return this.query<MapPoint>(
      this.docs,
      "SELECT c.id, c.name, c.title, c.x, c.y, c.clusterId FROM c WHERE c.status = 'ready' AND IS_NUMBER(c.x) AND IS_NUMBER(c.y)",
    );
  }

  async similar(embedding: number[], k: number, excludeId: string): Promise<SimilarHit[]> {
    const rows = await this.query<DocSummary & { score: number }>(
      this.docs,
      `SELECT TOP @k ${select(LIST_FIELDS)}, VectorDistance(c.embedding, @emb) AS score FROM c ` +
        "WHERE c.status = 'ready' AND c.id != @id ORDER BY VectorDistance(c.embedding, @emb)",
      [
        { name: '@k', value: k },
        { name: '@emb', value: embedding },
        { name: '@id', value: excludeId },
      ],
    );
    return rows.map(({ score, ...doc }) => ({ doc, score }));
  }

  async setPositions(updates: PositionUpdate[]): Promise<void> {
    await mapLimit(updates, 16, async (u) => {
      try {
        await this.docs.item(u.id, CORPUS).patch([
          { op: 'set', path: '/x', value: u.x },
          { op: 'set', path: '/y', value: u.y },
          { op: 'set', path: '/clusterId', value: u.clusterId },
        ]);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    });
  }

  async createBatch(batch: Batch): Promise<void> {
    await this.batches.items.create(batch);
  }

  async getBatch(id: string): Promise<Batch | undefined> {
    try {
      const { resource } = await this.batches.item(id, CORPUS).read<Batch>();
      return resource ? clean(resource) : undefined;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async listBatches(limit: number): Promise<Batch[]> {
    const rows = await this.query<Batch>(
      this.batches,
      'SELECT TOP @n c.id, c.corpus, c.createdAt, c.createdBy, c.label FROM c ORDER BY c.createdAt DESC',
      [{ name: '@n', value: limit }],
    );
    return rows;
  }

  async saveClusterRun(run: ClusterRun): Promise<void> {
    await this.runs.items.upsert(run);
  }

  async latestClusterRun(onlyDone = false): Promise<ClusterRun | undefined> {
    const rows = await this.query<ClusterRun>(
      this.runs,
      `SELECT TOP 1 * FROM c ${onlyDone ? "WHERE c.status = 'done'" : ''} ORDER BY c.createdAt DESC`,
    );
    return rows[0] ? clean(rows[0]) : undefined;
  }
}
