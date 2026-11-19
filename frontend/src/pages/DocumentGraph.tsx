import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowLeft, Columns2, ExternalLink, FileText, Network, SlidersHorizontal, X } from 'lucide-react'
import { useDeferredValue, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ScoreLegend, SimilarityGraph } from '@/components/graph/SimilarityGraph'
import { StatusBadge } from '@/components/StatusBadge'
import { Badge, Button, EmptyState, Slider, Spinner, Switch, Tooltip } from '@/components/ui'
import { api, ApiError, type SimilarResult } from '@/lib/api'
import { clusterColor, docTitle, formatBytes, scoreColor, timeAgo } from '@/lib/utils'

function PropertiesPane({
  id,
  centerId,
  similar,
  onClose,
}: {
  id: string
  centerId: string
  similar?: SimilarResult
  onClose: () => void
}) {
  const navigate = useNavigate()
  const doc = useQuery({ queryKey: ['doc', id], queryFn: () => api.document(id) })
  const map = useQuery({ queryKey: ['map'], queryFn: api.map, staleTime: 30_000 })
  const d = doc.data
  const isCenter = id === centerId
  const score = similar?.neighbors.find((n) => n.id === id)?.score
  const cluster = map.data?.run?.clusters.find((c) => c.id === d?.clusterId)

  return (
    <div className="absolute bottom-3 right-3 top-3 z-20 flex w-96 flex-col overflow-hidden rounded-xl border border-border bg-panel/95 shadow-2xl backdrop-blur">
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted">
            {isCenter ? 'Selected document' : 'Similar document'}
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm font-semibold leading-snug">{d ? docTitle(d) : 'Loading…'}</div>
          {d && <div className="mt-0.5 truncate text-[11px] text-muted">{d.name}</div>}
        </div>
        <button className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-fg" onClick={onClose} title="Close">
          <X className="size-4" />
        </button>
      </div>
      {!d ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <div className="scrollbar-thin min-h-0 flex-1 space-y-5 overflow-y-auto p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={d.status} />
            {cluster && (
              <Badge tone="neutral">
                <span className="size-2 rounded-full" style={{ background: clusterColor(cluster.id) }} />
                {cluster.label}
              </Badge>
            )}
            {score !== undefined && (
              <Badge tone="neutral">
                <span style={{ color: scoreColor(score) }} className="font-mono">
                  {score.toFixed(3)}
                </span>
                similarity
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {!isCenter && (
              <Button size="sm" onClick={() => navigate(`/compare/${centerId}/${id}`)}>
                <Columns2 /> Compare side by side
              </Button>
            )}
            {!isCenter && (
              <Button size="sm" variant="secondary" onClick={() => navigate(`/documents/${id}`)}>
                <Network /> Open its graph
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => void api.openFile(d.id)}>
              <ExternalLink /> Original
            </Button>
          </div>
          {d.summary && <p className="leading-relaxed text-fg/90">{d.summary}</p>}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <dt className="text-muted">Size</dt>
            <dd>{formatBytes(d.size)}</dd>
            <dt className="text-muted">Pages</dt>
            <dd>{d.pageCount ?? '—'}</dd>
            <dt className="text-muted">Body characters</dt>
            <dd>{d.bodyChars?.toLocaleString() ?? '—'}</dd>
            <dt className="text-muted">Header/footer lines removed</dt>
            <dd>
              {d.removedLines ?? '—'} {d.bodyMethod && <span className="text-muted">({d.bodyMethod})</span>}
            </dd>
            <dt className="text-muted">Chunks embedded</dt>
            <dd>{d.chunkCount ?? '—'}</dd>
            <dt className="text-muted">Uploaded</dt>
            <dd>{timeAgo(d.createdAt)}</dd>
          </dl>
          {isCenter && similar && similar.neighbors.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Nearest neighbors</div>
              <div className="space-y-0.5">
                {similar.neighbors.map((n) => (
                  <div key={n.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-panel-2">
                    <span className="size-2 shrink-0 rounded-full" style={{ background: clusterColor(n.clusterId) }} />
                    <Link to={`/documents/${n.id}`} className="min-w-0 flex-1 truncate text-xs hover:underline">
                      {docTitle(n)}
                    </Link>
                    <Tooltip content="Compare side by side">
                      <button
                        className="rounded p-0.5 text-muted opacity-0 hover:text-fg group-hover:opacity-100"
                        onClick={() => navigate(`/compare/${centerId}/${n.id}`)}
                      >
                        <Columns2 className="size-3.5" />
                      </button>
                    </Tooltip>
                    <span className="font-mono text-[11px]" style={{ color: scoreColor(n.score) }}>
                      {n.score.toFixed(3)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {d.bodyPreview && (
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">Cleaned body (preview)</div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-panel-2 p-3 font-sans text-xs leading-relaxed text-fg/80">
                {d.bodyPreview}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function DocumentGraphPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [k, setK] = useState(12)
  const [minScore, setMinScore] = useState(0.3)
  const [crossLinks, setCrossLinks] = useState(true)
  const [showControls, setShowControls] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const dk = useDeferredValue(k)
  const dMin = useDeferredValue(minScore)

  useEffect(() => {
    setSelected(null)
  }, [id])

  const doc = useQuery({
    queryKey: ['doc', id],
    queryFn: () => api.document(id),
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'ready' && q.state.data.status !== 'failed' ? 2_000 : false),
  })
  const ready = doc.data?.status === 'ready'
  const similar = useQuery({
    queryKey: ['similar', id, dk, dMin, crossLinks],
    queryFn: () => api.similar(id, dk, dMin, crossLinks),
    enabled: ready,
    placeholderData: keepPreviousData,
  })
  const map = useQuery({ queryKey: ['map'], queryFn: api.map, staleTime: 30_000 })
  const cluster = map.data?.run?.clusters.find((c) => c.id === doc.data?.clusterId)

  if (doc.error) {
    return (
      <EmptyState title={doc.error instanceof ApiError && doc.error.status === 404 ? 'Document not found' : 'Could not load document'}>
        <Link to="/" className="text-accent-2 hover:underline">
          Back to overview
        </Link>
      </EmptyState>
    )
  }

  const d = doc.data
  return (
    <div className="relative h-full">
      <div className="absolute inset-0">
        {!d || (ready && !similar.data) ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : !ready ? (
          <EmptyState icon={<FileText className="size-5" />} title={d.status === 'failed' ? 'Processing failed' : 'Processing document…'}>
            {d.status === 'failed' ? d.error : 'The similarity graph is available once the embedding is ready.'}
          </EmptyState>
        ) : similar.data!.neighbors.length === 0 ? (
          <EmptyState title="No similar documents above the threshold">Lower the minimum score to see more neighbors.</EmptyState>
        ) : (
          <SimilarityGraph result={similar.data!} onOpen={(nid) => navigate(`/documents/${nid}`)} onSelect={setSelected} />
        )}
      </div>

      {/* Title + controls overlay */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[calc(100%-26rem)] flex-col items-start gap-2">
        <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-border bg-panel/85 py-2 pl-2 pr-3 shadow-xl backdrop-blur">
          <button onClick={() => navigate(-1)} className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg" title="Back">
            <ArrowLeft className="size-4" />
          </button>
          <button className="min-w-0 text-left" onClick={() => setSelected(id)} title="Show details">
            <div className="truncate text-sm font-semibold">{d ? docTitle(d) : 'Loading…'}</div>
            {d && (
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                <span className="truncate">{d.name}</span>
                {cluster && (
                  <span className="flex shrink-0 items-center gap-1">
                    <span className="size-1.5 rounded-full" style={{ background: clusterColor(cluster.id) }} />
                    {cluster.label}
                  </span>
                )}
              </div>
            )}
          </button>
          <div className="h-7 w-px bg-border" />
          <Tooltip content="Graph settings">
            <button
              className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg data-[on=true]:bg-panel-2 data-[on=true]:text-fg"
              data-on={showControls}
              onClick={() => setShowControls((v) => !v)}
            >
              <SlidersHorizontal className="size-4" />
            </button>
          </Tooltip>
          {similar.isFetching && similar.data && <Spinner />}
        </div>
        {showControls && (
          <div className="pointer-events-auto flex flex-col gap-3 rounded-xl border border-border bg-panel/90 p-4 text-xs text-muted shadow-xl backdrop-blur">
            <label className="flex items-center gap-3">
              <span className="w-20">Neighbors</span>
              <Slider className="w-40" min={3} max={40} step={1} value={[k]} onValueChange={([v]) => setK(v)} />
              <span className="w-8 font-mono text-fg">{k}</span>
            </label>
            <label className="flex items-center gap-3">
              <span className="w-20">Min score</span>
              <Slider className="w-40" min={0} max={0.95} step={0.01} value={[minScore]} onValueChange={([v]) => setMinScore(v)} />
              <span className="w-8 font-mono text-fg">{minScore.toFixed(2)}</span>
            </label>
            <label className="flex items-center gap-3">
              <span className="w-20">Cross-links</span>
              <Switch checked={crossLinks} onCheckedChange={setCrossLinks} />
            </label>
            <ScoreLegend />
          </div>
        )}
        {!selected && ready && (
          <div className="rounded-lg bg-panel/70 px-2.5 py-1 text-[11px] text-muted backdrop-blur">
            Click a document for details and side-by-side comparison · double-click to open its graph
          </div>
        )}
      </div>

      {selected && <PropertiesPane id={selected} centerId={id} similar={similar.data} onClose={() => setSelected(null)} />}
    </div>
  )
}
