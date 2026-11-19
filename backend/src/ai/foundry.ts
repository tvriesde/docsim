import { AzureOpenAI } from 'openai';
import { getBearerTokenProvider, type TokenCredential } from '@azure/identity';
import type { Config } from '../config.js';
import { normalizeLanguage } from '../lib/language.js';
import { truncate } from '../lib/text.js';
import type {
  AiService,
  ChatMessage,
  ClusterLabel,
  ClusterLabelInput,
  CompareAnalysis,
  CompareInput,
  ComparePoint,
  DocumentAnalysis,
  DocumentAnalysisInput,
} from './types.js';

const ANALYZE_SYSTEM = `You prepare documents for semantic similarity analysis.
You receive the first and last lines of (a sample of) the pages of one document, plus the start of its text.
1. Identify lines that are page furniture and NOT body content: running headers, running footers, page numbers,
   document/company names repeated on every page, confidentiality notices, print dates, revision stamps, URLs in footers.
   A real heading or sentence that only occurs once is body content. The document's own title or a section heading
   at the top of the first page is body content too, unless it also repeats on other pages or carries
   document-control data (document IDs, confidentiality marks, page numbers). When unsure, keep it (do not list it).
2. Give the document a concise descriptive title (max 12 words) based on its body content.
3. Summarize the body in 1-2 sentences (max 60 words).
4. Identify the main language of the body text as an ISO 639-1 code (e.g. "en", "nl", "de", "fr").
Reply with JSON only: {"headerFooterLines": [<lines copied exactly as shown>], "title": "...", "summary": "...", "language": "xx"}`;

const LABEL_SYSTEM = `You name clusters of similar documents for a dashboard.
Given distinctive keywords and representative documents of one cluster, reply with JSON only:
{"label": "<2-4 word topic name in Title Case>", "description": "<one sentence describing what the documents share>"}`;

const COMPARE_SYSTEM = `You compare two documents for a user who wants to understand why they are similar.
You get both documents' titles, summaries and excerpts, their overall embedding similarity (cosine, 0-1),
and numbered pairs of the most similar passages (A passage / B passage).
Reply with JSON only:
{"verdict": "<2-5 words, e.g. Near-duplicate, Same product different version, Same topic, Loosely related>",
 "overview": "<3-5 sentences: what both documents are, how and why they are similar, the most important difference>",
 "similarities": [{"topic": "<short>", "detail": "<one sentence>"}],
 "differences": [{"topic": "<short>", "detail": "<one sentence>"}],
 "matchNotes": ["<for each numbered passage pair, in order: max 15 words on what they share or how they differ>"]}
Give 3-6 similarities and 2-5 differences. Be concrete (names, amounts, clauses), never invent facts. Answer in English.`;

export class FoundryAi implements AiService {
  readonly kind = 'foundry' as const;
  private client: AzureOpenAI;

  constructor(
    private config: Config,
    credential: TokenCredential,
  ) {
    if (!config.openAiEndpoint || !config.chatDeployment || !config.embeddingDeployment) {
      throw new Error('AI=foundry needs AZURE_OPENAI_ENDPOINT, MODEL_CHAT and MODEL_EMBEDDING');
    }
    this.client = new AzureOpenAI({
      endpoint: config.openAiEndpoint,
      apiVersion: config.openAiApiVersion,
      azureADTokenProvider: getBearerTokenProvider(credential, 'https://cognitiveservices.azure.com/.default'),
      maxRetries: 8,
      timeout: 120_000,
    });
  }

  private async complete(messages: { role: string; content: string }[], maxTokens: number, json: boolean): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.config.chatDeployment,
      messages,
      max_completion_tokens: maxTokens,
    };
    if (json) body.response_format = { type: 'json_object' };
    if (this.config.chatReasoningEffort) body.reasoning_effort = this.config.chatReasoningEffort;
    const res = await this.client.chat.completions.create(body as never);
    const content = (res as { choices: { message: { content: string | null } }[] }).choices[0]?.message?.content;
    if (!content) throw new Error('LLM returned an empty response');
    return content;
  }

  private async chatJson<T>(system: string, user: string, maxTokens: number): Promise<T> {
    const content = await this.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      maxTokens,
      true,
    );
    return JSON.parse(content) as T;
  }

  async analyzeDocument(input: DocumentAnalysisInput): Promise<DocumentAnalysis> {
    const edges = input.edges
      .map((e) => `--- page ${e.page} top ---\n${e.top.join('\n')}\n--- page ${e.page} bottom ---\n${e.bottom.join('\n')}`)
      .join('\n');
    const user =
      `File name: ${input.name}\nTotal pages: ${input.pageCount}\n\n` +
      `PAGE EDGES (first/last lines per page):\n${edges}\n\n` +
      `START OF TEXT:\n${truncate(input.sample, 6000)}`;
    const out = await this.chatJson<Partial<DocumentAnalysis>>(ANALYZE_SYSTEM, user, 1500);
    return {
      headerFooterLines: Array.isArray(out.headerFooterLines) ? out.headerFooterLines.filter((l) => typeof l === 'string') : [],
      title: typeof out.title === 'string' ? out.title.trim() : '',
      summary: typeof out.summary === 'string' ? out.summary.trim() : '',
      language: normalizeLanguage(out.language),
    };
  }

  async labelCluster(input: ClusterLabelInput): Promise<ClusterLabel> {
    const docs = input.docs.map((d, i) => `${i + 1}. ${d.title}: ${truncate(d.summary, 300)}`).join('\n');
    const user = `Keywords: ${input.keywords.join(', ')}\n\nRepresentative documents:\n${docs}`;
    const out = await this.chatJson<Partial<ClusterLabel>>(LABEL_SYSTEM, user, 300);
    return { label: String(out.label ?? '').trim(), description: String(out.description ?? '').trim() };
  }

  async compareDocuments(input: CompareInput): Promise<CompareAnalysis> {
    const doc = (tag: string, d: CompareInput['a']) =>
      `DOCUMENT ${tag}: ${d.title}\nSummary: ${d.summary}\nExcerpt:\n${truncate(d.excerpt, 8000)}`;
    const pairs = input.matches
      .map((m, i) => `#${i + 1} (similarity ${m.score.toFixed(2)})\nA: ${truncate(m.a, 700)}\nB: ${truncate(m.b, 700)}`)
      .join('\n\n');
    const user =
      `Overall similarity: ${input.score.toFixed(3)}\n\n${doc('A', input.a)}\n\n${doc('B', input.b)}\n\n` +
      `MOST SIMILAR PASSAGE PAIRS:\n${pairs || '(none)'}`;
    const out = await this.chatJson<Partial<CompareAnalysis>>(COMPARE_SYSTEM, user, 3000);
    const points = (v: unknown): ComparePoint[] =>
      Array.isArray(v)
        ? v
            .filter((p): p is ComparePoint => !!p && typeof p === 'object')
            .map((p) => ({ topic: String(p.topic ?? '').trim(), detail: String(p.detail ?? '').trim() }))
            .filter((p) => p.topic || p.detail)
        : [];
    return {
      verdict: String(out.verdict ?? '').trim(),
      overview: String(out.overview ?? '').trim(),
      similarities: points(out.similarities),
      differences: points(out.differences),
      matchNotes: Array.isArray(out.matchNotes) ? out.matchNotes.map((n) => String(n ?? '').trim()) : [],
    };
  }

  async chat(system: string, messages: ChatMessage[]): Promise<string> {
    return this.complete([{ role: 'system', content: system }, ...messages], 2000, false);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await this.client.embeddings.create({
      model: this.config.embeddingDeployment,
      input: texts,
      dimensions: this.config.embeddingDimensions,
    });
    return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
