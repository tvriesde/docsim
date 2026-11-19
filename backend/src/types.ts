export const CORPUS = 'default';

export type DocStatus = 'queued' | 'extracting' | 'cleaning' | 'embedding' | 'ready' | 'failed';
export const ACTIVE_STATUSES: DocStatus[] = ['queued', 'extracting', 'cleaning', 'embedding'];

export interface DocRecord {
  id: string;
  corpus: string;
  name: string;
  mime: string;
  size: number;
  blobName: string;
  batchId: string;
  uploadedBy?: string;
  status: DocStatus;
  error?: string;
  pageCount?: number;
  rawChars?: number;
  bodyChars?: number;
  removedLines?: number;
  bodyMethod?: 'llm' | 'heuristic';
  title?: string;
  summary?: string;
  bodyPreview?: string;
  /** ISO 639-1 code of the body language, or 'und' when unknown. */
  language?: string;
  chunkCount?: number;
  embedding?: number[];
  proj?: number[];
  clusterId?: number | null;
  x?: number | null;
  y?: number | null;
  createdAt: string;
  updatedAt: string;
  processedAt?: string;
}

export type DocSummary = Omit<DocRecord, 'embedding' | 'proj'>;

export interface Batch {
  id: string;
  corpus: string;
  createdAt: string;
  createdBy?: string;
  label?: string;
}

export interface BatchProgress extends Batch {
  total: number;
  counts: Partial<Record<DocStatus, number>>;
  done: boolean;
}

export interface ClusterInfo {
  id: number;
  label: string;
  description?: string;
  keywords: string[];
  size: number;
  cx: number;
  cy: number;
}

export interface ClusterRun {
  id: string;
  corpus: string;
  status: 'running' | 'done' | 'failed';
  trigger: 'auto' | 'manual';
  createdAt: string;
  finishedAt?: string;
  error?: string;
  docCount: number;
  noiseCount: number;
  params: { minClusterSize: number; minSamples: number; nNeighbors: number };
  clusters: ClusterInfo[];
}

export interface MapPoint {
  id: string;
  name: string;
  title?: string;
  x: number;
  y: number;
  clusterId: number;
}

export interface SimilarHit {
  doc: DocSummary;
  score: number;
}

export interface ListDocsQuery {
  status?: DocStatus;
  clusterId?: number;
  batchId?: string;
  q?: string;
  limit: number;
  offset: number;
}
