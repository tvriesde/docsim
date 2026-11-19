export interface PageEdges {
  page: number;
  top: string[];
  bottom: string[];
}

export interface DocumentAnalysisInput {
  name: string;
  pageCount: number;
  edges: PageEdges[];
  sample: string;
}

export interface DocumentAnalysis {
  /** Lines (as shown in the edges) that are running headers, footers or page furniture. */
  headerFooterLines: string[];
  title: string;
  summary: string;
  /** ISO 639-1 code of the body language, when the analyzer reports it. */
  language?: string;
}

export interface ClusterLabelInput {
  keywords: string[];
  docs: { title: string; summary: string }[];
}

export interface ClusterLabel {
  label: string;
  description: string;
}

export interface CompareDocInput {
  title: string;
  summary: string;
  excerpt: string;
}

export interface CompareInput {
  a: CompareDocInput;
  b: CompareDocInput;
  /** Document-level cosine similarity. */
  score: number;
  /** Most similar passage pairs, best first. */
  matches: { a: string; b: string; score: number }[];
}

export interface ComparePoint {
  topic: string;
  detail: string;
}

export interface CompareAnalysis {
  verdict: string;
  overview: string;
  similarities: ComparePoint[];
  differences: ComparePoint[];
  /** One short note per input match (same order) explaining what the passages share. */
  matchNotes: string[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiService {
  readonly kind: 'foundry' | 'fake';
  analyzeDocument(input: DocumentAnalysisInput): Promise<DocumentAnalysis>;
  labelCluster(input: ClusterLabelInput): Promise<ClusterLabel>;
  embed(texts: string[]): Promise<number[][]>;
  compareDocuments(input: CompareInput): Promise<CompareAnalysis>;
  chat(system: string, messages: ChatMessage[]): Promise<string>;
}
