import type {
  Batch,
  ClusterRun,
  DocRecord,
  DocStatus,
  DocSummary,
  ListDocsQuery,
  MapPoint,
  SimilarHit,
} from '../types.js';

export interface PositionUpdate {
  id: string;
  x: number | null;
  y: number | null;
  clusterId: number | null;
}

export interface LayoutRow {
  id: string;
  name: string;
  title?: string;
  summary?: string;
  /** Low-dimensional random projection of the embedding (see lib/projection.ts). */
  proj: number[];
}

export interface Store {
  init(): Promise<void>;

  createDoc(doc: DocRecord): Promise<void>;
  getDoc(id: string, withEmbedding?: boolean): Promise<DocRecord | undefined>;
  patchDoc(id: string, patch: Partial<DocRecord>): Promise<void>;
  deleteDoc(id: string): Promise<void>;
  listDocs(query: ListDocsQuery): Promise<{ items: DocSummary[]; total: number }>;
  countByStatus(): Promise<Partial<Record<DocStatus, number>>>;
  idsByStatus(statuses: DocStatus[]): Promise<string[]>;
  batchStatuses(batchId: string): Promise<DocStatus[]>;
  layoutRows(): Promise<LayoutRow[]>;
  embeddingsFor(ids: string[]): Promise<Map<string, number[]>>;
  mapPoints(): Promise<MapPoint[]>;
  /** Nearest ready documents by cosine similarity, most similar first. */
  similar(embedding: number[], k: number, excludeId: string): Promise<SimilarHit[]>;
  setPositions(updates: PositionUpdate[]): Promise<void>;

  createBatch(batch: Batch): Promise<void>;
  getBatch(id: string): Promise<Batch | undefined>;
  listBatches(limit: number): Promise<Batch[]>;

  saveClusterRun(run: ClusterRun): Promise<void>;
  latestClusterRun(onlyDone?: boolean): Promise<ClusterRun | undefined>;
}

export function stripEmbedding(doc: DocRecord): DocSummary {
  const { embedding: _e, proj: _p, ...rest } = doc;
  return rest;
}
