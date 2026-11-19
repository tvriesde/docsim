import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { FakeAi } from '../src/ai/fake.js';
import { loadConfig } from '../src/config.js';
import { LocalBlobStore } from '../src/store/blobs.js';
import { MemoryStore } from '../src/store/memory.js';

const SAMPLES = path.resolve(__dirname, '../../sample-data');

function multipart(files: { name: string; data: Buffer }[]): { body: Buffer; contentType: string } {
  const boundary = '----docsim' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      f.data,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('API (memory store, fake AI)', () => {
  let app: FastifyInstance;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'docsim-'));
    process.env.LOG_LEVEL = 'warn';
    const config = { ...loadConfig(), dataDir: dir, authEnabled: false, autoRecluster: true, reclusterDebounceMs: 50 };
    app = await buildApp(config, {
      store: new MemoryStore(),
      blobs: new LocalBlobStore(path.join(dir, 'blobs')),
      ai: new FakeAi(256),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves health without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('ingests a batch, clusters it and returns similar documents', async () => {
    const batch = (await app.inject({ method: 'POST', url: '/api/batches', payload: { label: 'test' } })).json();
    const names = (await readdir(SAMPLES)).sort();
    expect(names.length).toBeGreaterThanOrEqual(16);
    const files = await Promise.all(names.map(async (name) => ({ name, data: await readFile(path.join(SAMPLES, name)) })));
    files.push({ name: 'bad.exe', data: Buffer.from('nope') });
    const { body, contentType } = multipart(files);
    const up = await app.inject({
      method: 'POST',
      url: `/api/batches/${batch.id}/files`,
      payload: body,
      headers: { 'content-type': contentType },
    });
    expect(up.statusCode).toBe(200);
    const upload = up.json();
    expect(upload.accepted).toHaveLength(names.length);
    expect(upload.rejected).toHaveLength(1);

    const progress = await waitFor(async () => {
      const p = (await app.inject({ method: 'GET', url: `/api/batches/${batch.id}` })).json();
      return p.done ? p : undefined;
    });
    expect(progress.counts.ready).toBe(names.length);

    const docs = (await app.inject({ method: 'GET', url: '/api/documents?limit=100' })).json();
    const pdf = docs.items.find((d: { name: string }) => d.name === 'contracts-1.pdf');
    expect(pdf.pageCount).toBe(3);
    expect(pdf.removedLines).toBeGreaterThan(0);
    expect(pdf.embedding).toBeUndefined();

    const bodyText = (await app.inject({ method: 'GET', url: `/api/documents/${pdf.id}/body` })).body;
    expect(bodyText).not.toContain('ACME Holdings');
    expect(bodyText).toContain('supplier');

    const sim = (await app.inject({ method: 'GET', url: `/api/documents/${pdf.id}/similar?k=5` })).json();
    expect(sim.center.id).toBe(pdf.id);
    expect(sim.neighbors).toHaveLength(5);
    const top3 = sim.neighbors.slice(0, 3).map((n: { name: string }) => n.name);
    expect(top3.every((n: string) => n.startsWith('contracts-'))).toBe(true);
    expect(sim.edges.some((e: { kind: string }) => e.kind === 'cross')).toBe(true);

    // auto recluster after the batch drained
    const map = await waitFor(async () => {
      const m = (await app.inject({ method: 'GET', url: '/api/map' })).json();
      return m.run?.status === 'done' ? m : undefined;
    });
    expect(map.points).toHaveLength(names.length);
    expect(map.run.clusters.length).toBeGreaterThanOrEqual(2);
    expect(map.run.clusters[0].label).toBeTruthy();

    const manual = await app.inject({ method: 'POST', url: '/api/clusters/recompute', payload: {} });
    expect(manual.statusCode).toBe(202);
    await waitFor(async () => {
      const c = (await app.inject({ method: 'GET', url: '/api/clusters' })).json();
      return !c.running && c.lastDone?.trigger === 'manual' ? c : undefined;
    });

    const stats = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
    expect(stats.counts.ready).toBe(names.length);

    const pairs = (await app.inject({ method: 'GET', url: '/api/pairs' })).json();
    expect(pairs.docCount).toBe(names.length);
    expect(pairs.pairs.length).toBeGreaterThan(0);
    const top = pairs.pairs[0];
    expect(top.a < top.b).toBe(true);
    expect(pairs.docs[top.a].name).toBeTruthy();
    expect(pairs.docs[top.a].language).toMatch(/^([a-z]{2}|und)$/);
    const dis = await app.inject({ method: 'POST', url: '/api/pairs/dismiss', payload: { a: top.b, b: top.a } });
    expect(Object.keys(dis.json().dismissed)).toEqual([`${top.a}|${top.b}`]);
    expect(Object.keys((await app.inject({ method: 'GET', url: '/api/pairs' })).json().dismissed)).toHaveLength(1);

    const del = await app.inject({ method: 'DELETE', url: `/api/documents/${pdf.id}` });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/documents/${pdf.id}` })).statusCode).toBe(404);
    const after = (await app.inject({ method: 'GET', url: '/api/pairs' })).json();
    expect(after.docCount).toBe(names.length - 1);
    expect(after.pairs.every((p: { a: string; b: string }) => p.a !== pdf.id && p.b !== pdf.id)).toBe(true);

    const rest = (await app.inject({ method: 'GET', url: '/api/documents?limit=100' })).json().items as { id: string; clusterId: number }[];
    const bulk = await app.inject({ method: 'POST', url: '/api/documents/delete', payload: { ids: [rest[0].id, rest[1].id, 'missing'] } });
    expect(bulk.json()).toEqual({ deleted: 2, notFound: 1 });
    const cluster = rest.slice(2).find((d) => d.clusterId >= 0)!.clusterId;
    const inCluster = rest.slice(2).filter((d) => d.clusterId === cluster).length;
    const byCluster = await app.inject({ method: 'POST', url: '/api/documents/delete', payload: { filter: { clusterId: cluster } } });
    expect(byCluster.json().deleted).toBe(inCluster);
    const mapAfter = (await app.inject({ method: 'GET', url: '/api/map' })).json();
    expect(mapAfter.run.clusters.some((c: { id: number }) => c.id === cluster)).toBe(false);
    expect(mapAfter.points.some((p: { clusterId: number }) => p.clusterId === cluster)).toBe(false);
    const left = (await app.inject({ method: 'GET', url: '/api/documents?limit=100' })).json();
    expect(left.total).toBe(rest.length - 2 - inCluster);
    expect((await app.inject({ method: 'POST', url: '/api/documents/delete', payload: { filter: {} } })).statusCode).toBe(400);
  }, 120_000);
});
