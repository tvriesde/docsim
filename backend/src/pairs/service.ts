import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { mapLimit, nowIso } from '../lib/util.js';
import type { BlobStore } from '../store/blobs.js';
import type { Store } from '../store/store.js';
import type { DocSummary } from '../types.js';

const CACHE_BLOB = 'pairs/v2/latest.json';
const DISMISSED_BLOB = 'pairs/dismissed.json';
/** Nearest neighbours fetched per document; pairs beyond this rank are never flagged. */
const NEIGHBOURS = 10;
/** Pairs below this score are dropped. Low enough to show the score distribution under the UI threshold. */
const FLOOR = 0.75;
const EMBEDDING_CHUNK = 50;

/** Document info for display. Cluster membership is not included: it changes with reclustering (use /api/map). */
export interface PairDoc {
  id: string;
  name: string;
  title?: string;
  pageCount?: number;
  bodyChars?: number;
  language?: string;
  updatedAt: string;
}

export interface Pair {
  a: string;
  b: string;
  score: number;
}

export interface PairsSnapshot {
  fingerprint: string;
  computedAt: string;
  docCount: number;
  neighbours: number;
  floor: number;
  docs: Record<string, PairDoc>;
  pairs: Pair[];
}

export interface Dismissal {
  by?: string;
  at: string;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function toPairDoc(d: DocSummary): PairDoc {
  return {
    id: d.id,
    name: d.name,
    title: d.title,
    pageCount: d.pageCount,
    bodyChars: d.bodyChars,
    language: d.language,
    updatedAt: d.updatedAt,
  };
}

/** Flags near-duplicate document pairs: every ready document's top-k neighbours by whole-document cosine. */
export class PairsService {
  private cache?: PairsSnapshot;
  private inflight?: Promise<PairsSnapshot>;
  private dismissWrite: Promise<unknown> = Promise.resolve();

  constructor(
    private store: Store,
    private blobs: BlobStore,
    private log: FastifyBaseLogger,
  ) {}

  /** Drops the cached snapshot (documents were added, reprocessed or removed). */
  invalidate(): void {
    this.cache = undefined;
    void this.blobs.delete(CACHE_BLOB).catch((err) => this.log.warn({ err }, 'could not delete pairs cache'));
  }

  async get(refresh = false): Promise<PairsSnapshot & { dismissed: Record<string, Dismissal> }> {
    const ids = (await this.store.idsByStatus(['ready'])).sort();
    const fingerprint = createHash('sha1').update(ids.join(',')).digest('hex');
    let snap = refresh ? undefined : this.cache;
    if (!refresh && snap?.fingerprint !== fingerprint) {
      const stored = await this.blobs.getText(CACHE_BLOB);
      snap = stored ? (JSON.parse(stored) as PairsSnapshot) : undefined;
    }
    if (!snap || snap.fingerprint !== fingerprint) {
      this.inflight ??= this.compute(ids, fingerprint).finally(() => (this.inflight = undefined));
      snap = await this.inflight;
    }
    this.cache = snap;
    return { ...snap, dismissed: await this.dismissed() };
  }

  async dismissed(): Promise<Record<string, Dismissal>> {
    const text = await this.blobs.getText(DISMISSED_BLOB);
    return text ? (JSON.parse(text) as Record<string, Dismissal>) : {};
  }

  setDismissed(a: string, b: string, dismissed: boolean, by?: string): Promise<Record<string, Dismissal>> {
    const run = this.dismissWrite.then(async () => {
      const all = await this.dismissed();
      const key = pairKey(a, b);
      if (dismissed) all[key] = { by, at: nowIso() };
      else delete all[key];
      await this.blobs.putText(DISMISSED_BLOB, JSON.stringify(all));
      return all;
    });
    this.dismissWrite = run.catch(() => undefined);
    return run;
  }

  private async compute(ids: string[], fingerprint: string): Promise<PairsSnapshot> {
    const started = Date.now();
    const docs: Record<string, PairDoc> = {};
    const pairs = new Map<string, Pair>();
    for (let i = 0; i < ids.length; i += EMBEDDING_CHUNK) {
      const chunk = ids.slice(i, i + EMBEDDING_CHUNK);
      const vectors = await this.store.embeddingsFor(chunk);
      await mapLimit(chunk, 6, async (id) => {
        const embedding = vectors.get(id);
        if (!embedding) return;
        for (const hit of await this.store.similar(embedding, NEIGHBOURS, id)) {
          docs[hit.doc.id] ??= toPairDoc(hit.doc);
          if (hit.score < FLOOR) continue;
          const key = pairKey(id, hit.doc.id);
          if (!pairs.has(key)) {
            const [a, b] = key.split('|');
            pairs.set(key, { a, b, score: Math.round(hit.score * 10_000) / 10_000 });
          }
        }
      });
    }
    const used = new Set([...pairs.values()].flatMap((p) => [p.a, p.b]));
    for (const id of used) {
      if (docs[id]) continue;
      const d = await this.store.getDoc(id);
      if (d) docs[id] = toPairDoc(d);
    }
    for (const id of Object.keys(docs)) if (!used.has(id)) delete docs[id];
    const snap: PairsSnapshot = {
      fingerprint,
      computedAt: nowIso(),
      docCount: ids.length,
      neighbours: NEIGHBOURS,
      floor: FLOOR,
      docs,
      pairs: [...pairs.values()].sort((x, y) => y.score - x.score),
    };
    await this.blobs.putText(CACHE_BLOB, JSON.stringify(snap)).catch((err) => this.log.warn({ err }, 'could not cache pairs'));
    this.log.info({ docs: ids.length, pairs: snap.pairs.length, ms: Date.now() - started }, 'near-duplicate pairs computed');
    return snap;
  }
}
