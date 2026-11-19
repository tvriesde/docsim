import { getToken } from './auth'
import { config } from './config'

export type DocStatus = 'queued' | 'extracting' | 'cleaning' | 'embedding' | 'ready' | 'failed'
export const ACTIVE_STATUSES: DocStatus[] = ['queued', 'extracting', 'cleaning', 'embedding']

export interface DocSummary {
  id: string
  name: string
  mime: string
  size: number
  batchId: string
  uploadedBy?: string
  status: DocStatus
  error?: string
  pageCount?: number
  rawChars?: number
  bodyChars?: number
  removedLines?: number
  bodyMethod?: 'llm' | 'heuristic'
  title?: string
  summary?: string
  bodyPreview?: string
  /** ISO 639-1 code, or 'und' when unknown. */
  language?: string
  chunkCount?: number
  clusterId?: number | null
  x?: number | null
  y?: number | null
  createdAt: string
  updatedAt: string
  processedAt?: string
}

export interface ClusterInfo {
  id: number
  label: string
  description?: string
  keywords: string[]
  size: number
  cx: number
  cy: number
}

export interface ClusterRun {
  id: string
  status: 'running' | 'done' | 'failed'
  trigger: 'auto' | 'manual'
  createdAt: string
  finishedAt?: string
  error?: string
  docCount: number
  noiseCount: number
  params: { minClusterSize: number; minSamples: number; nNeighbors: number }
  clusters: ClusterInfo[]
}

export interface MapPoint {
  id: string
  name: string
  title?: string
  x: number
  y: number
  clusterId: number
}

export interface Stats {
  counts: Record<DocStatus, number>
  total: number
  clusterCount: number
  noiseCount: number
  lastClusteredAt: string | null
  clustering: boolean
  queue: number
  ai: string
}

export interface Batch {
  id: string
  createdAt: string
  createdBy?: string
  label?: string
}

export interface BatchProgress extends Batch {
  total: number
  counts: Partial<Record<DocStatus, number>>
  done: boolean
}

export interface SimilarResult {
  center: DocSummary
  neighbors: (DocSummary & { score: number })[]
  edges: { source: string; target: string; score: number; kind: 'primary' | 'cross' }[]
}

export interface UploadResult {
  accepted: { id: string; name: string; size: number }[]
  rejected: { name: string; reason: string }[]
}

export interface ComparePoint {
  topic: string
  detail: string
}

export interface CompareResult {
  a: DocSummary
  b: DocSummary
  score: number
  passagesA: string[]
  passagesB: string[]
  matches: { a: number; b: number; score: number; note?: string }[]
  analysis: {
    verdict: string
    overview: string
    similarities: ComparePoint[]
    differences: ComparePoint[]
  } | null
  analysisError?: string
  createdAt: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface PairDoc {
  id: string
  name: string
  title?: string
  pageCount?: number
  bodyChars?: number
  language?: string
  updatedAt: string
}

export interface Pair {
  a: string
  b: string
  score: number
}

export interface PairsResult {
  computedAt: string
  docCount: number
  neighbours: number
  floor: number
  docs: Record<string, PairDoc>
  pairs: Pair[]
  dismissed: Record<string, { by?: string; at: string }>
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = await getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetch(`${config().apiBaseUrl}${path}`, { ...init, headers })
  if (!res.ok) {
    let message = res.statusText
    try {
      message = ((await res.json()) as { error?: string }).error ?? message
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, message || `Request failed (${res.status})`)
  }
  if (res.status === 204) return undefined as T
  const type = res.headers.get('content-type') ?? ''
  return (type.includes('json') ? await res.json() : await res.text()) as T
}

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v))
  const str = s.toString()
  return str ? `?${str}` : ''
}

export const api = {
  me: () => request<{ id: string; name: string; username?: string }>('/api/me'),
  stats: () => request<Stats>('/api/stats'),
  map: () => request<{ run: ClusterRun | null; points: MapPoint[] }>('/api/map'),
  clusters: () => request<{ latest: ClusterRun | null; lastDone: ClusterRun | null; running: boolean }>('/api/clusters'),
  recompute: () => request<ClusterRun>('/api/clusters/recompute', { method: 'POST', body: '{}' }),
  documents: (q: { status?: string; clusterId?: number; batchId?: string; q?: string; limit?: number; offset?: number }) =>
    request<{ items: DocSummary[]; total: number }>(`/api/documents${qs(q)}`),
  document: (id: string) => request<DocSummary>(`/api/documents/${id}`),
  body: (id: string) => request<string>(`/api/documents/${id}/body`),
  similar: (id: string, k: number, minScore: number, crossLinks: boolean) =>
    request<SimilarResult>(`/api/documents/${id}/similar${qs({ k, minScore, crossLinks })}`),
  reprocess: (id: string) => request<{ id: string }>(`/api/documents/${id}/reprocess`, { method: 'POST', body: '{}' }),
  compare: (a: string, b: string, refresh = false) =>
    request<CompareResult>('/api/compare', { method: 'POST', body: JSON.stringify({ a, b, refresh }) }),
  compareChat: (a: string, b: string, messages: ChatMessage[]) =>
    request<{ reply: string }>('/api/compare/chat', { method: 'POST', body: JSON.stringify({ a, b, messages }) }),
  pairs: (refresh = false) => request<PairsResult>(`/api/pairs${qs({ refresh: refresh || undefined })}`),
  dismissPair: (a: string, b: string, dismissed: boolean) =>
    request<{ dismissed: PairsResult['dismissed'] }>('/api/pairs/dismiss', {
      method: 'POST',
      body: JSON.stringify({ a, b, dismissed }),
    }),
  remove: (id: string) => request<void>(`/api/documents/${id}`, { method: 'DELETE' }),
  bulkDelete: (body: { ids?: string[]; filter?: { clusterId?: number; status?: string; batchId?: string; q?: string } }) =>
    request<{ deleted: number; notFound: number }>('/api/documents/delete', { method: 'POST', body: JSON.stringify(body) }),
  createBatch: (label?: string) => request<Batch>('/api/batches', { method: 'POST', body: JSON.stringify({ label }) }),
  batches: () => request<Batch[]>('/api/batches'),
  batch: (id: string) => request<BatchProgress>(`/api/batches/${id}`),
  upload: (batchId: string, files: File[]) => {
    const form = new FormData()
    for (const f of files) form.append('files', f, f.name)
    return request<UploadResult>(`/api/batches/${batchId}/files`, { method: 'POST', body: form })
  },
  /** Opens the original file in a new tab (fetched with the bearer token). */
  openFile: async (id: string) => {
    const token = await getToken()
    const res = await fetch(`${config().apiBaseUrl}/api/documents/${id}/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) throw new ApiError(res.status, 'Could not open file')
    const url = URL.createObjectURL(await res.blob())
    window.open(url, '_blank', 'noopener')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  },
}
