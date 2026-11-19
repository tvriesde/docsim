import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { DefaultAzureCredential } from '@azure/identity';
import type { Config } from './config.js';
import { FakeAi } from './ai/fake.js';
import { FoundryAi } from './ai/foundry.js';
import type { AiService, ChatMessage } from './ai/types.js';
import { ClusterService } from './clustering/service.js';
import { CompareService } from './compare/service.js';
import { PairsService } from './pairs/service.js';
import { bodyBlobName, IngestService } from './ingest/pipeline.js';
import { detectKind, mimeFor, SUPPORTED_EXTENSIONS } from './ingest/extract.js';
import { createAuthHook } from './lib/auth.js';
import { HttpError, mapLimit, nowIso } from './lib/util.js';
import { cosine } from './lib/vector.js';
import { AzureBlobStore, LocalBlobStore, type BlobStore } from './store/blobs.js';
import { CosmosStore } from './store/cosmos.js';
import { MemoryStore } from './store/memory.js';
import type { Store } from './store/store.js';
import { ACTIVE_STATUSES, CORPUS, type BatchProgress, type DocRecord, type DocStatus } from './types.js';

export interface AppDeps {
  store: Store;
  blobs: BlobStore;
  ai: AiService;
}

export function createDeps(config: Config): AppDeps {
  const needsAzure = config.store === 'cosmos' || config.blob === 'azure' || config.ai === 'foundry';
  const credential = needsAzure
    ? new DefaultAzureCredential(config.azureClientId ? { managedIdentityClientId: config.azureClientId } : {})
    : undefined;
  return {
    store:
      config.store === 'cosmos'
        ? new CosmosStore(config.cosmosEndpoint, config.cosmosDatabase, credential!)
        : new MemoryStore(path.join(config.dataDir, 'store.json')),
    blobs:
      config.blob === 'azure'
        ? new AzureBlobStore(config.storageAccountUrl, config.blobContainer, credential!)
        : new LocalBlobStore(path.join(config.dataDir, 'blobs')),
    ai: config.ai === 'foundry' ? new FoundryAi(config, credential!) : new FakeAi(config.embeddingDimensions),
  };
}

const STATUSES: DocStatus[] = ['queued', 'extracting', 'cleaning', 'embedding', 'ready', 'failed'];
const MAX_BULK_DELETE = 5000;

function safeName(name: string): string {
  return path.basename(name).replace(/[^\w.\- ()]+/g, '_').slice(0, 180) || 'file';
}

function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function floatParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export async function buildApp(config: Config, deps: AppDeps = createDeps(config)): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 1024 * 1024,
    genReqId: () => randomUUID(),
  });
  const { store, blobs, ai } = deps;

  await store.init();
  await blobs.init();

  const clusters = new ClusterService(store, ai, app.log, config.reclusterDebounceMs);
  const pairs = new PairsService(store, blobs, app.log);
  const ingest = new IngestService(store, blobs, ai, config.ingestConcurrency, app.log, (ready) => {
    if (ready > 0) pairs.invalidate();
    if (ready > 0 && config.autoRecluster) clusters.schedule();
  });
  app.decorate('ingest', ingest);
  app.decorate('clusters', clusters);
  const compare = new CompareService(store, blobs, ai, app.log);

  /** Deletes a document with its original file and body blobs. Returns false if it did not exist. */
  const deleteDoc = async (id: string): Promise<boolean> => {
    const doc = await store.getDoc(id);
    if (!doc) return false;
    await store.deleteDoc(id);
    await Promise.all([blobs.delete(doc.blobName), blobs.delete(bodyBlobName(id))]);
    return true;
  };

  await app.register(cors, {
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });
  await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 200 } });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    reply.code(status).send({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  app.get('/api/health', async () => ({ status: 'ok', ai: ai.kind, time: nowIso() }));

  const authHook = createAuthHook(config);
  await app.register(async (api) => {
    api.addHook('onRequest', authHook);

    api.get('/api/me', async (req) => req.user);

    api.get('/api/stats', async () => {
      const [counts, run] = await Promise.all([store.countByStatus(), store.latestClusterRun(true)]);
      const latest = await store.latestClusterRun();
      return {
        counts: Object.fromEntries(STATUSES.map((s) => [s, counts[s] ?? 0])),
        total: Object.values(counts).reduce((a, b) => a + (b ?? 0), 0),
        clusterCount: run?.clusters.length ?? 0,
        noiseCount: run?.noiseCount ?? 0,
        lastClusteredAt: run?.finishedAt ?? null,
        clustering: clusters.running || latest?.status === 'running',
        queue: ingest.pending,
        ai: ai.kind,
      };
    });

    // Batches and uploads
    api.post('/api/batches', async (req) => {
      const body = (req.body ?? {}) as { label?: string };
      const batch = { id: randomUUID(), corpus: CORPUS, createdAt: nowIso(), createdBy: req.user?.username ?? req.user?.name, label: body.label };
      await store.createBatch(batch);
      return batch;
    });

    api.get('/api/batches', async () => store.listBatches(20));

    api.get('/api/batches/:id', async (req) => {
      const { id } = req.params as { id: string };
      const batch = await store.getBatch(id);
      if (!batch) throw new HttpError(404, 'Batch not found');
      const statuses = await store.batchStatuses(id);
      const counts: Partial<Record<DocStatus, number>> = {};
      statuses.forEach((s) => (counts[s] = (counts[s] ?? 0) + 1));
      const progress: BatchProgress = {
        ...batch,
        total: statuses.length,
        counts,
        done: statuses.every((s) => !ACTIVE_STATUSES.includes(s)),
      };
      return progress;
    });

    api.post('/api/batches/:id/files', async (req) => {
      const { id: batchId } = req.params as { id: string };
      if (!(await store.getBatch(batchId))) throw new HttpError(404, 'Batch not found');
      const accepted: { id: string; name: string; size: number }[] = [];
      const rejected: { name: string; reason: string }[] = [];
      for await (const part of req.files()) {
        const name = safeName(part.filename);
        const kind = detectKind(name);
        if (!kind) {
          part.file.resume();
          rejected.push({ name, reason: `Unsupported type (allowed: ${SUPPORTED_EXTENSIONS.join(', ')})` });
          continue;
        }
        const id = randomUUID();
        const blobName = `raw/${id}/${name}`;
        const size = await blobs.putStream(blobName, part.file, mimeFor(kind));
        if (part.file.truncated) {
          await blobs.delete(blobName);
          rejected.push({ name, reason: `File exceeds ${config.maxUploadMb} MB` });
          continue;
        }
        const now = nowIso();
        const doc: DocRecord = {
          id,
          corpus: CORPUS,
          name,
          mime: mimeFor(kind),
          size,
          blobName,
          batchId,
          uploadedBy: req.user?.username ?? req.user?.name,
          status: 'queued',
          createdAt: now,
          updatedAt: now,
        };
        await store.createDoc(doc);
        accepted.push({ id, name, size });
      }
      ingest.enqueue(accepted.map((a) => a.id));
      return { accepted, rejected };
    });

    // Documents
    api.get('/api/documents', async (req) => {
      const q = req.query as Record<string, string | undefined>;
      const status = STATUSES.includes(q.status as DocStatus) ? (q.status as DocStatus) : undefined;
      const clusterId = q.clusterId !== undefined && q.clusterId !== '' ? Number.parseInt(q.clusterId, 10) : undefined;
      return store.listDocs({
        status,
        clusterId: Number.isFinite(clusterId) ? clusterId : undefined,
        batchId: q.batchId || undefined,
        q: q.q?.trim() || undefined,
        limit: intParam(q.limit, 50, 1, 200),
        offset: intParam(q.offset, 0, 0, 1_000_000),
      });
    });

    api.get('/api/documents/:id', async (req) => {
      const { id } = req.params as { id: string };
      const doc = await store.getDoc(id);
      if (!doc) throw new HttpError(404, 'Document not found');
      return doc;
    });

    api.get('/api/documents/:id/body', async (req, reply) => {
      const { id } = req.params as { id: string };
      const text = await blobs.getText(bodyBlobName(id));
      if (text === undefined) throw new HttpError(404, 'Body not available');
      reply.type('text/plain; charset=utf-8');
      return text;
    });

    api.get('/api/documents/:id/file', async (req, reply) => {
      const { id } = req.params as { id: string };
      const doc = await store.getDoc(id);
      if (!doc) throw new HttpError(404, 'Document not found');
      const file = await blobs.open(doc.blobName);
      if (!file) throw new HttpError(404, 'File not found');
      reply
        .type(file.contentType)
        .header('Content-Length', file.size)
        .header('Content-Disposition', `inline; filename="${encodeURIComponent(doc.name)}"`);
      return reply.send(file.stream);
    });

    api.get('/api/documents/:id/similar', async (req) => {
      const { id } = req.params as { id: string };
      const q = req.query as Record<string, string | undefined>;
      const k = intParam(q.k, 15, 1, 50);
      const minScore = floatParam(q.minScore, 0, -1, 1);
      const crossLinks = q.crossLinks !== 'false';
      const doc = await store.getDoc(id, true);
      if (!doc) throw new HttpError(404, 'Document not found');
      if (doc.status !== 'ready' || !doc.embedding) throw new HttpError(409, 'Document is not processed yet');
      const hits = (await store.similar(doc.embedding, k, id)).filter((h) => h.score >= minScore);
      const { embedding: _e, proj: _p, ...center } = doc;
      const edges: { source: string; target: string; score: number; kind: 'primary' | 'cross' }[] = hits.map((h) => ({
        source: id,
        target: h.doc.id,
        score: h.score,
        kind: 'primary',
      }));
      if (crossLinks && hits.length > 1) {
        const vectors = await store.embeddingsFor(hits.map((h) => h.doc.id));
        for (let i = 0; i < hits.length; i++) {
          for (let j = i + 1; j < hits.length; j++) {
            const a = vectors.get(hits[i].doc.id);
            const b = vectors.get(hits[j].doc.id);
            if (!a || !b) continue;
            const score = cosine(a, b);
            if (score >= Math.max(minScore, 0)) {
              edges.push({ source: hits[i].doc.id, target: hits[j].doc.id, score, kind: 'cross' });
            }
          }
        }
      }
      return { center, neighbors: hits.map((h) => ({ ...h.doc, score: h.score })), edges };
    });

    api.post('/api/compare', async (req) => {
      const body = (req.body ?? {}) as { a?: string; b?: string; refresh?: boolean };
      if (typeof body.a !== 'string' || typeof body.b !== 'string') throw new HttpError(400, 'Body needs document ids a and b');
      return compare.compare(body.a, body.b, body.refresh === true);
    });

    api.post('/api/compare/chat', async (req) => {
      const body = (req.body ?? {}) as { a?: string; b?: string; messages?: unknown };
      if (typeof body.a !== 'string' || typeof body.b !== 'string') throw new HttpError(400, 'Body needs document ids a and b');
      const messages = (Array.isArray(body.messages) ? body.messages : [])
        .filter(
          (m): m is ChatMessage =>
            !!m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
        )
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
      if (messages.length === 0 || messages.at(-1)!.role !== 'user') throw new HttpError(400, 'The last message must be from the user');
      return { reply: await compare.chat(body.a, body.b, messages) };
    });

    // Near-duplicate pairs
    api.get('/api/pairs', async (req) => {
      const q = req.query as Record<string, string | undefined>;
      return pairs.get(q.refresh === 'true');
    });

    api.post('/api/pairs/dismiss', async (req) => {
      const body = (req.body ?? {}) as { a?: string; b?: string; dismissed?: boolean };
      if (typeof body.a !== 'string' || typeof body.b !== 'string' || body.a === body.b) {
        throw new HttpError(400, 'Body needs two different document ids a and b');
      }
      const dismissed = await pairs.setDismissed(body.a, body.b, body.dismissed !== false, req.user?.username ?? req.user?.name);
      return { dismissed };
    });

    api.post('/api/documents/:id/reprocess', async (req) => {
      const { id } = req.params as { id: string };
      const doc = await store.getDoc(id);
      if (!doc) throw new HttpError(404, 'Document not found');
      if (ACTIVE_STATUSES.includes(doc.status) && doc.status !== 'queued') throw new HttpError(409, 'Document is being processed');
      await store.patchDoc(id, { status: 'queued', error: undefined, updatedAt: nowIso() });
      ingest.enqueue([id]);
      return { id, status: 'queued' };
    });

    api.delete('/api/documents/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await deleteDoc(id))) throw new HttpError(404, 'Document not found');
      return reply.code(204).send();
    });

    /** Bulk delete by explicit ids and/or a filter (e.g. a whole cluster). Reclusters afterwards. */
    api.post('/api/documents/delete', async (req) => {
      const body = (req.body ?? {}) as {
        ids?: unknown;
        filter?: { clusterId?: number; status?: string; batchId?: string; q?: string };
      };
      const ids = new Set(Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : []);
      const f = body.filter;
      if (f && typeof f === 'object') {
        const status = STATUSES.includes(f.status as DocStatus) ? (f.status as DocStatus) : undefined;
        const clusterId = typeof f.clusterId === 'number' && Number.isInteger(f.clusterId) ? f.clusterId : undefined;
        const batchId = typeof f.batchId === 'string' && f.batchId ? f.batchId : undefined;
        const q = typeof f.q === 'string' && f.q.trim() ? f.q.trim() : undefined;
        if (status === undefined && clusterId === undefined && batchId === undefined && q === undefined) {
          throw new HttpError(400, 'A delete filter needs at least one criterion');
        }
        // Collect first, then delete, so offsets stay stable while paging.
        for (let offset = 0; ; offset += 200) {
          const page = await store.listDocs({ status, clusterId, batchId, q, limit: 200, offset });
          page.items.forEach((d) => ids.add(d.id));
          if (page.items.length < 200 || ids.size > MAX_BULK_DELETE) break;
        }
      }
      if (ids.size === 0) throw new HttpError(400, 'Nothing to delete');
      if (ids.size > MAX_BULK_DELETE) throw new HttpError(400, `At most ${MAX_BULK_DELETE} documents can be deleted at once`);
      const results = await mapLimit([...ids], 8, (id) => deleteDoc(id));
      const deleted = results.filter(Boolean).length;
      req.log.info({ deleted, requested: ids.size }, 'bulk delete');
      if (deleted > 0 && config.autoRecluster) clusters.schedule();
      return { deleted, notFound: ids.size - deleted };
    });

    // Clusters / map
    api.get('/api/map', async () => {
      const [run, points] = await Promise.all([store.latestClusterRun(true), store.mapPoints()]);
      if (!run) return { run: null, points };
      // The stored run can be stale after deletes; reflect live membership until the next recluster.
      const sizes = new Map<number, number>();
      for (const p of points) sizes.set(p.clusterId, (sizes.get(p.clusterId) ?? 0) + 1);
      const clustersLive = run.clusters
        .filter((c) => (sizes.get(c.id) ?? 0) > 0)
        .map((c) => ({ ...c, size: sizes.get(c.id)! }));
      return { run: { ...run, clusters: clustersLive }, points };
    });

    api.get('/api/clusters', async () => {
      const [latest, lastDone] = await Promise.all([store.latestClusterRun(), store.latestClusterRun(true)]);
      return { latest: latest ?? null, lastDone: lastDone ?? null, running: clusters.running };
    });

    api.post('/api/clusters/recompute', async (req, reply) => {
      const body = (req.body ?? {}) as { minClusterSize?: number; minSamples?: number; nNeighbors?: number };
      const overrides = {
        ...(body.minClusterSize ? { minClusterSize: intParam(body.minClusterSize, 5, 2, 500) } : {}),
        ...(body.minSamples ? { minSamples: intParam(body.minSamples, 3, 1, 500) } : {}),
        ...(body.nNeighbors ? { nNeighbors: intParam(body.nNeighbors, 15, 2, 200) } : {}),
      };
      const run = await clusters.start('manual', overrides);
      return reply.code(202).send(run);
    });
  });

  app.addHook('onReady', async () => {
    await ingest.resume();
    void ingest
      .backfillLanguages()
      .then((n) => {
        if (n > 0) pairs.invalidate();
      })
      .catch((err) => app.log.warn({ err }, 'language backfill failed'));
  });
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    ingest: IngestService;
    clusters: ClusterService;
  }
}
