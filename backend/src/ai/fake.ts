import { createHash } from 'node:crypto';
import { normalize } from '../lib/vector.js';
import { tokenize } from '../lib/text.js';
import { detectRepeatedEdgeLines } from '../ingest/body.js';
import type {
  AiService,
  ChatMessage,
  ClusterLabel,
  ClusterLabelInput,
  CompareAnalysis,
  CompareInput,
  DocumentAnalysis,
  DocumentAnalysisInput,
} from './types.js';

function hash(token: string): number {
  return createHash('md5').update(token).digest().readUInt32LE(0);
}

/**
 * Deterministic offline stand-in for Foundry, for local development and tests:
 * hashed bag-of-words embeddings (so similar texts really are similar) and heuristic analysis.
 */
export class FakeAi implements AiService {
  readonly kind = 'fake' as const;

  constructor(private dims: number) {}

  async analyzeDocument(input: DocumentAnalysisInput): Promise<DocumentAnalysis> {
    // Title and summary are left empty so the pipeline derives them from the cleaned body.
    return { headerFooterLines: detectRepeatedEdgeLines(input.edges), title: '', summary: '' };
  }

  async labelCluster(input: ClusterLabelInput): Promise<ClusterLabel> {
    const words = input.keywords.slice(0, 3).map((w) => w[0].toUpperCase() + w.slice(1));
    return { label: words.join(' · ') || 'Cluster', description: `Documents about ${input.keywords.slice(0, 5).join(', ')}.` };
  }

  async compareDocuments(input: CompareInput): Promise<CompareAnalysis> {
    return {
      verdict: input.score > 0.9 ? 'Near-duplicate' : input.score > 0.7 ? 'Same topic' : 'Loosely related',
      overview: `"${input.a.title}" and "${input.b.title}" have an overall similarity of ${input.score.toFixed(2)}. (Offline mode: no LLM analysis.)`,
      similarities: input.matches.slice(0, 3).map((m, i) => ({ topic: `Passage pair ${i + 1}`, detail: `Similarity ${m.score.toFixed(2)}.` })),
      differences: [],
      matchNotes: input.matches.map((m) => `Similarity ${m.score.toFixed(2)}`),
    };
  }

  async chat(_system: string, messages: ChatMessage[]): Promise<string> {
    return `(Offline mode) You asked: "${messages.at(-1)?.content ?? ''}". Configure AI=foundry for real answers.`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const v = new Array<number>(this.dims).fill(0);
      const tokens = tokenize(text);
      const add = (t: string, w: number) => {
        const h = hash(t);
        v[h % this.dims] += (h & 0x80000000 ? -1 : 1) * w;
      };
      tokens.forEach((t, i) => {
        add(t, 1);
        if (i > 0) add(`${tokens[i - 1]} ${t}`, 0.5);
      });
      return normalize(v);
    });
  }
}
