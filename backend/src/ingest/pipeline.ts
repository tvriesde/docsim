import type { FastifyBaseLogger } from 'fastify';
import type { AiService, DocumentAnalysis } from '../ai/types.js';
import { projectEmbedding } from '../lib/projection.js';
import { detectLanguage } from '../lib/language.js';
import { truncate } from '../lib/text.js';
import { nowIso } from '../lib/util.js';
import type { BlobStore } from '../store/blobs.js';
import type { Store } from '../store/store.js';
import { ACTIVE_STATUSES, type DocRecord } from '../types.js';
import { detectRepeatedEdgeLines, pageEdges, removeHeaderFooter } from './body.js';
import { embedDocument } from './embed.js';
import { detectKind, extractPages } from './extract.js';

export const bodyBlobName = (id: string) => `bodies/${id}.txt`;

/**
 * In-process ingestion queue with bounded concurrency. Progress is persisted on the document (status field),
 * so unfinished documents are picked up again after a restart (see resume()).
 */
export class IngestService {
  private queue: string[] = [];
  private queued = new Set<string>();
  private running = 0;
  private readySinceDrain = 0;

  constructor(
    private store: Store,
    private blobs: BlobStore,
    private ai: AiService,
    private concurrency: number,
    private log: FastifyBaseLogger,
    private onDrained: (readyCount: number) => void,
  ) {}

  get pending(): number {
    return this.queue.length + this.running;
  }

  enqueue(ids: string[]): void {
    for (const id of ids) {
      if (this.queued.has(id)) continue;
      this.queued.add(id);
      this.queue.push(id);
    }
    this.pump();
  }

  async resume(): Promise<number> {
    const ids = await this.store.idsByStatus(ACTIVE_STATUSES);
    if (ids.length) this.log.info({ count: ids.length }, 'resuming unfinished ingestion');
    this.enqueue(ids);
    return ids.length;
  }

  /** Sets `language` on ready documents ingested before language detection existed. Returns the number updated. */
  async backfillLanguages(): Promise<number> {
    const missing: string[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = await this.store.listDocs({ status: 'ready', limit: 200, offset });
      for (const d of page.items) if (!d.language) missing.push(d.id);
      if (page.items.length < 200) break;
    }
    let updated = 0;
    for (const id of missing) {
      const body = await this.blobs.getText(bodyBlobName(id)).catch(() => undefined);
      if (body === undefined) continue;
      await this.store.patchDoc(id, { language: detectLanguage(body) });
      updated++;
    }
    if (updated) this.log.info({ updated }, 'language backfilled');
    return updated;
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.running++;
      this.process(id)
        .catch((err) => this.log.error({ err, id }, 'ingestion crashed'))
        .finally(() => {
          this.running--;
          this.queued.delete(id);
          this.pump();
          if (this.pending === 0) {
            const ready = this.readySinceDrain;
            this.readySinceDrain = 0;
            this.onDrained(ready);
          }
        });
    }
  }

  private async process(id: string): Promise<void> {
    const doc = await this.store.getDoc(id);
    if (!doc) return;
    const started = Date.now();
    try {
      await this.ingest(doc);
      this.readySinceDrain++;
      this.log.info({ id, name: doc.name, ms: Date.now() - started }, 'document ingested');
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.log.warn({ id, name: doc.name, err: message }, 'document ingestion failed');
      await this.store.patchDoc(id, { status: 'failed', error: truncate(message, 500), updatedAt: nowIso() });
    }
  }

  private async ingest(doc: DocRecord): Promise<void> {
    const { id } = doc;
    await this.store.patchDoc(id, { status: 'extracting', error: undefined, updatedAt: nowIso() });
    const kind = detectKind(doc.name);
    if (!kind) throw new Error(`Unsupported file type: ${doc.name}`);
    const pages = await extractPages(await this.blobs.getBuffer(doc.blobName), kind);
    const rawText = pages.map((p) => p.join('\n')).join('\n\n');
    const rawChars = rawText.replace(/\s/g, '').length;
    if (rawChars < 20) {
      throw new Error('No extractable text (scanned or image-only PDF? OCR is not enabled).');
    }

    await this.store.patchDoc(id, { status: 'cleaning', pageCount: pages.length, rawChars, updatedAt: nowIso() });
    const edges = pageEdges(pages);
    let analysis: DocumentAnalysis;
    let bodyMethod: DocRecord['bodyMethod'] = 'llm';
    try {
      analysis = await this.ai.analyzeDocument({ name: doc.name, pageCount: pages.length, edges, sample: rawText.slice(0, 8000) });
    } catch (err) {
      this.log.warn({ id, err: (err as Error).message }, 'LLM body extraction failed; using heuristic');
      bodyMethod = 'heuristic';
      analysis = { headerFooterLines: detectRepeatedEdgeLines(edges), title: '', summary: '' };
    }
    if (this.ai.kind === 'fake') bodyMethod = 'heuristic';
    const { body, removed } = removeHeaderFooter(pages, analysis.headerFooterLines);
    if (!body.trim()) throw new Error('Document body is empty after removing headers and footers.');
    await this.blobs.putText(bodyBlobName(id), body);
    const title = analysis.title || body.split('\n').find((l) => l.trim().length > 3)?.trim() || doc.name;
    const summary = analysis.summary || body.split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    const language = analysis.language || detectLanguage(body);

    await this.store.patchDoc(id, {
      status: 'embedding',
      title: truncate(title, 160),
      summary: truncate(summary, 600),
      language,
      bodyChars: body.length,
      removedLines: removed,
      bodyMethod,
      bodyPreview: truncate(body, 1500),
      updatedAt: nowIso(),
    });
    const { embedding, chunkCount } = await embedDocument(this.ai, body);

    await this.store.patchDoc(id, {
      status: 'ready',
      embedding,
      proj: projectEmbedding(embedding),
      chunkCount,
      clusterId: null,
      x: null,
      y: null,
      processedAt: nowIso(),
      updatedAt: nowIso(),
    });
  }
}
