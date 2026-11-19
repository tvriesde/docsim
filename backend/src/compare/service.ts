import type { FastifyBaseLogger } from 'fastify';
import type { AiService, ChatMessage, CompareAnalysis } from '../ai/types.js';
import { bodyBlobName } from '../ingest/pipeline.js';
import { HttpError, nowIso } from '../lib/util.js';
import { cosine, normalize } from '../lib/vector.js';
import type { BlobStore } from '../store/blobs.js';
import { stripEmbedding, type Store } from '../store/store.js';
import type { DocRecord, DocSummary } from '../types.js';

const CACHE_VERSION = 'v1';
const EMBED_BATCH = 64;
const MAX_PASSAGES = 400;
/** Passages shorter than this (headings, labels) are shown but never matched: they match spuriously. */
const MIN_MATCH_CHARS = 60;
const MATCH_THRESHOLD = 0.6;
const MAX_MATCHES = 40;
const LLM_MATCHES = 15;
const CHAT_CONTEXT_CHARS = 40_000;

export interface PassageMatch {
  a: number;
  b: number;
  score: number;
  note?: string;
}

export interface CompareResult {
  version: string;
  a: DocSummary;
  b: DocSummary;
  score: number;
  passagesA: string[];
  passagesB: string[];
  matches: PassageMatch[];
  analysis: CompareAnalysis | null;
  analysisError?: string;
  createdAt: string;
}

/**
 * Splits text into display passages (groups of whole lines), breaking at blank lines once a passage is long
 * enough and hard-breaking long runs. Joining passages with '\n' reproduces the text without blank lines.
 */
export function splitPassages(text: string, maxPassages = MAX_PASSAGES): string[] {
  const target = Math.max(450, Math.ceil(text.length / maxPassages));
  const passages: string[] = [];
  let current: string[] = [];
  let len = 0;
  const flush = () => {
    if (current.length) passages.push(current.join('\n'));
    current = [];
    len = 0;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      if (len >= target * 0.4) flush();
      continue;
    }
    if (len > 0 && len + line.length > target * 2) flush();
    current.push(line);
    len += line.length + 1;
    if (len >= target && /[.:;!?]$/.test(line)) flush();
  }
  flush();
  return passages;
}

/** Greedy one-to-one matching of the most similar passage pairs above the threshold. Vectors must be normalized. */
export function matchPassages(
  va: (number[] | null)[],
  vb: (number[] | null)[],
  threshold = MATCH_THRESHOLD,
  max = MAX_MATCHES,
): PassageMatch[] {
  const pairs: PassageMatch[] = [];
  for (let i = 0; i < va.length; i++) {
    const x = va[i];
    if (!x) continue;
    for (let j = 0; j < vb.length; j++) {
      const y = vb[j];
      if (!y) continue;
      let s = 0;
      for (let k = 0; k < x.length; k++) s += x[k] * y[k];
      if (s >= threshold) pairs.push({ a: i, b: j, score: s });
    }
  }
  pairs.sort((p, q) => q.score - p.score);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const out: PassageMatch[] = [];
  for (const p of pairs) {
    if (usedA.has(p.a) || usedB.has(p.b)) continue;
    usedA.add(p.a);
    usedB.add(p.b);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

export class CompareService {
  private inflight = new Map<string, Promise<CompareResult>>();

  constructor(
    private store: Store,
    private blobs: BlobStore,
    private ai: AiService,
    private log: FastifyBaseLogger,
  ) {}

  private cacheName(a: string, b: string) {
    return `compare/${CACHE_VERSION}/${a}_${b}.json`;
  }

  private async loadDoc(id: string): Promise<{ doc: DocRecord; body: string }> {
    const doc = await this.store.getDoc(id, true);
    if (!doc) throw new HttpError(404, `Document ${id} not found`);
    if (doc.status !== 'ready' || !doc.embedding) throw new HttpError(409, `Document ${doc.name} is not processed yet`);
    const body = await this.blobs.getText(bodyBlobName(id));
    if (body === undefined) throw new HttpError(404, `Body of ${doc.name} is not available`);
    return { doc, body };
  }

  async compare(a: string, b: string, refresh = false): Promise<CompareResult> {
    if (a === b) throw new HttpError(400, 'Pick two different documents');
    const key = `${a}_${b}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.run(a, b, refresh).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async run(a: string, b: string, refresh: boolean): Promise<CompareResult> {
    const [A, B] = await Promise.all([this.loadDoc(a), this.loadDoc(b)]);
    const name = this.cacheName(a, b);
    if (!refresh) {
      const cached = await this.blobs.getText(name).catch(() => undefined);
      if (cached) {
        const r = JSON.parse(cached) as CompareResult;
        if (r.version === CACHE_VERSION && r.a.updatedAt === A.doc.updatedAt && r.b.updatedAt === B.doc.updatedAt) {
          return { ...r, a: stripEmbedding(A.doc), b: stripEmbedding(B.doc) };
        }
      }
    }

    const passagesA = splitPassages(A.body);
    const passagesB = splitPassages(B.body);
    const [va, vb] = await Promise.all([this.embedPassages(passagesA), this.embedPassages(passagesB)]);
    const matches = matchPassages(va, vb);
    const score = cosine(A.doc.embedding!, B.doc.embedding!);

    let analysis: CompareAnalysis | null = null;
    let analysisError: string | undefined;
    try {
      analysis = await this.ai.compareDocuments({
        a: { title: A.doc.title || A.doc.name, summary: A.doc.summary ?? '', excerpt: A.body },
        b: { title: B.doc.title || B.doc.name, summary: B.doc.summary ?? '', excerpt: B.body },
        score,
        matches: matches.slice(0, LLM_MATCHES).map((m) => ({ a: passagesA[m.a], b: passagesB[m.b], score: m.score })),
      });
      analysis.matchNotes.slice(0, LLM_MATCHES).forEach((note, i) => {
        if (matches[i] && note) matches[i].note = note;
      });
    } catch (err) {
      analysisError = (err as Error).message;
      this.log.warn({ a, b, err: analysisError }, 'LLM comparison failed');
    }

    const result: CompareResult = {
      version: CACHE_VERSION,
      a: stripEmbedding(A.doc),
      b: stripEmbedding(B.doc),
      score,
      passagesA,
      passagesB,
      matches,
      analysis,
      analysisError,
      createdAt: nowIso(),
    };
    if (analysis) await this.blobs.putText(name, JSON.stringify(result)).catch(() => undefined);
    return result;
  }

  private async embedPassages(passages: string[]): Promise<(number[] | null)[]> {
    const idx = passages
      .map((p, i) => (p.replace(/\s+/g, ' ').trim().length >= MIN_MATCH_CHARS ? i : -1))
      .filter((i) => i >= 0);
    const out: (number[] | null)[] = passages.map(() => null);
    for (let i = 0; i < idx.length; i += EMBED_BATCH) {
      const batch = idx.slice(i, i + EMBED_BATCH);
      const vectors = await this.ai.embed(batch.map((j) => passages[j]));
      batch.forEach((j, k) => (out[j] = normalize(vectors[k])));
    }
    return out;
  }

  async chat(a: string, b: string, messages: ChatMessage[]): Promise<string> {
    const [A, B] = await Promise.all([this.loadDoc(a), this.loadDoc(b)]);
    const cached = await this.blobs.getText(this.cacheName(a, b)).catch(() => undefined);
    const analysis = cached ? (JSON.parse(cached) as CompareResult).analysis : null;
    const clip = (s: string) => (s.length > CHAT_CONTEXT_CHARS ? `${s.slice(0, CHAT_CONTEXT_CHARS)}\n[... truncated]` : s);
    const system =
      `You help a user understand how two documents relate: why they are similar and where they differ.\n` +
      `Answer concisely (short paragraphs or bullet lists, plain text), quote or paraphrase concrete passages, and ` +
      `say which document (A or B) you refer to. Only use the documents below; say so if something is not in them.\n` +
      `Overall embedding similarity: ${cosine(A.doc.embedding!, B.doc.embedding!).toFixed(3)}\n` +
      (analysis ? `Earlier analysis: ${analysis.verdict}. ${analysis.overview}\n` : '') +
      `\n=== DOCUMENT A: ${A.doc.title || A.doc.name} (${A.doc.name}) ===\n${clip(A.body)}\n` +
      `\n=== DOCUMENT B: ${B.doc.title || B.doc.name} (${B.doc.name}) ===\n${clip(B.body)}\n`;
    return this.ai.chat(system, messages);
  }
}
