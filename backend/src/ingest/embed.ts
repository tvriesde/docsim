import type { AiService } from '../ai/types.js';
import { meanPool } from '../lib/vector.js';

/** ~3k tokens for English text; comfortably below the 8191-token input limit of text-embedding-3 models. */
export const CHUNK_CHARS = 12_000;
export const MAX_CHUNKS = 48;
const EMBED_BATCH = 16;

/** Splits text on paragraph boundaries into chunks of at most maxChars; samples evenly if there are too many. */
export function chunkText(text: string, maxChars = CHUNK_CHARS, maxChunks = MAX_CHUNKS): string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  for (const para of text.split(/\n{2,}/)) {
    if (para.length > maxChars) {
      flush();
      for (let i = 0; i < para.length; i += maxChars) chunks.push(para.slice(i, i + maxChars));
      continue;
    }
    if (current.length + para.length + 2 > maxChars) flush();
    current += (current ? '\n\n' : '') + para;
  }
  flush();
  if (chunks.length <= maxChunks) return chunks;
  return Array.from({ length: maxChunks }, (_, i) => chunks[Math.round((i * (chunks.length - 1)) / (maxChunks - 1))]);
}

/** Embeds each chunk and mean-pools (weighted by chunk length) into one normalized document vector. */
export async function embedDocument(ai: AiService, text: string): Promise<{ embedding: number[]; chunkCount: number }> {
  const chunks = chunkText(text);
  if (chunks.length === 0) throw new Error('Nothing to embed');
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    vectors.push(...(await ai.embed(chunks.slice(i, i + EMBED_BATCH))));
  }
  return { embedding: meanPool(vectors, chunks.map((c) => c.length)), chunkCount: chunks.length };
}
