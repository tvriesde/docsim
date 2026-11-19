import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Boxes,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FileStack,
  Layers,
  PanelRightOpen,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ClusterMap } from '@/components/map/ClusterMap'
import { Button, EmptyState, Input, Slider, Spinner, Switch, Tooltip } from '@/components/ui'
import { api } from '@/lib/api'
import { BANDS, differentLanguage, pairKey, useDupThreshold, useSameLanguage } from '@/lib/pairs'
import { clusterColor, cn, timeAgo } from '@/lib/utils'

const HIDDEN_KEY = 'docsim.hiddenClusters'

function Stat({ icon, label, value, warn }: { icon: ReactNode; label: string; value: ReactNode; warn?: boolean }) {
  return (
    <div className={cn('flex items-center gap-1.5 text-xs', warn ? 'text-rose-300' : 'text-muted')} title={label}>
      {icon}
      <span className="font-medium text-fg">{value}</span>
      <span className="hidden xl:inline">{label}</span>
    </div>
  )
}

/** Hidden cluster ids, remembered per cluster run (ids are only stable within one run). */
function useHiddenClusters(runId: string | undefined) {
  const [hidden, setHidden] = useState<Set<number>>(new Set())
  useEffect(() => {
    if (!runId) return
    try {
      const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? 'null') as { runId: string; ids: number[] } | null
      setHidden(new Set(saved?.runId === runId ? saved.ids : []))
    } catch {
      setHidden(new Set())
    }
  }, [runId])
  const update = (next: Set<number>) => {
    setHidden(next)
    if (runId) localStorage.setItem(HIDDEN_KEY, JSON.stringify({ runId, ids: [...next] }))
  }
  return {
    hidden,
    toggle: (id: number) => {
      const next = new Set(hidden)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      update(next)
    },
    set: update,
  }
}

export function DashboardPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 5_000 })
  const clustering = stats.data?.clustering ?? false
  const map = useQuery({ queryKey: ['map'], queryFn: api.map, refetchInterval: clustering ? 2_000 : 15_000 })
  const [selectedCluster, setSelectedCluster] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem('docsim.clusterPanel') !== '0')
  const { hidden, toggle, set: setHidden } = useHiddenClusters(map.data?.run?.id)
  const [showLinks, setShowLinks] = useState(() => localStorage.getItem('docsim.dupLinks') === '1')
  const [threshold, setThreshold] = useDupThreshold()
  const [sameLang, setSameLang] = useSameLanguage()
  const pairs = useQuery({ queryKey: ['pairs'], queryFn: () => api.pairs(), enabled: showLinks, staleTime: 60_000 })
  const links = useMemo(() => {
    if (!showLinks || !pairs.data) return undefined
    const { dismissed, docs } = pairs.data
    return pairs.data.pairs.filter(
      (p) => p.score >= threshold && !dismissed[pairKey(p.a, p.b)] && !(sameLang && differentLanguage(p, docs)),
    )
  }, [showLinks, pairs.data, threshold, sameLang])

  const toggleLinks = () => {
    localStorage.setItem('docsim.dupLinks', showLinks ? '0' : '1')
    setShowLinks(!showLinks)
  }

  const setPanel = (open: boolean) => {
    localStorage.setItem('docsim.clusterPanel', open ? '1' : '0')
    setPanelOpen(open)
  }

  const recompute = useMutation({
    mutationFn: api.recompute,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['stats'] })
      void qc.invalidateQueries({ queryKey: ['map'] })
    },
  })

  const deleteCluster = useMutation({
    mutationFn: (clusterId: number) => api.bulkDelete({ filter: { clusterId } }),
    onSuccess: (_r, clusterId) => {
      if (selectedCluster === clusterId) setSelectedCluster(null)
      qc.setQueryData<Awaited<ReturnType<typeof api.map>>>(['map'], (old) =>
        old && {
          run: old.run && { ...old.run, clusters: old.run.clusters.filter((c) => c.id !== clusterId) },
          points: old.points.filter((p) => p.clusterId !== clusterId),
        },
      )
      for (const key of ['stats', 'map', 'documents', 'pairs']) void qc.invalidateQueries({ queryKey: [key] })
    },
    onError: (e) => alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`),
  })

  const allPoints = useMemo(() => map.data?.points ?? [], [map.data])
  const clusters = useMemo(() => map.data?.run?.clusters ?? [], [map.data])
  const points = useMemo(() => allPoints.filter((p) => !hidden.has(p.clusterId)), [allPoints, hidden])
  const visibleClusters = useMemo(() => clusters.filter((c) => !hidden.has(c.id)), [clusters, hidden])
  const highlight = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return null
    return new Set(points.filter((p) => `${p.name} ${p.title ?? ''}`.toLowerCase().includes(q)).map((p) => p.id))
  }, [search, points])

  useEffect(() => {
    if (selectedCluster !== null && hidden.has(selectedCluster)) setSelectedCluster(null)
  }, [hidden, selectedCluster])

  const s = stats.data
  const busy = clustering || recompute.isPending

  return (
    <div className="relative h-full">
      <div className="absolute inset-0">
        {map.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : allPoints.length === 0 ? (
          <EmptyState icon={<Sparkles className="size-5" />} title="No clustered documents yet">
            {(s?.total ?? 0) > 0
              ? 'Documents are being processed. Clusters are computed automatically when a batch finishes.'
              : 'Upload a batch of PDF, DOCX or TXT files to get started.'}
          </EmptyState>
        ) : (
          <ClusterMap
            points={points}
            clusters={visibleClusters}
            selectedCluster={selectedCluster}
            highlight={highlight}
            links={links}
            insets={{ top: 72, right: panelOpen ? 344 : 16, bottom: 48, left: 16 }}
            onSelectDoc={(id) => navigate(`/documents/${id}`)}
            onSelectCluster={setSelectedCluster}
          />
        )}
      </div>

      {/* Top toolbar */}
      <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-3">
        <div className="pointer-events-auto flex items-center gap-4 rounded-xl border border-border bg-panel/85 px-4 py-2.5 shadow-xl backdrop-blur">
          <div>
            <div className="text-sm font-semibold leading-none">Overview</div>
            <div className="mt-1 text-[11px] text-muted">
              {s?.lastClusteredAt ? `Clustered ${timeAgo(s.lastClusteredAt)}` : 'Not clustered yet'}
            </div>
          </div>
          <div className="h-7 w-px bg-border" />
          <Stat icon={<FileStack className="size-3.5" />} label="documents" value={s?.total ?? '—'} />
          <Stat icon={<Boxes className="size-3.5" />} label="clusters" value={s?.clusterCount ?? '—'} />
          {(s?.queue ?? 0) > 0 && <Stat icon={<Layers className="size-3.5" />} label="processing" value={s!.queue} />}
          {s && s.noiseCount > 0 && <Stat icon={<Sparkles className="size-3.5" />} label="unclustered" value={s.noiseCount} />}
          {s && s.counts.failed > 0 && <Stat icon={<AlertTriangle className="size-3.5" />} label="failed" value={s.counts.failed} warn />}
        </div>
        <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-border bg-panel/85 p-1.5 shadow-xl backdrop-blur">
          <div className="relative w-56">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted" />
            <Input placeholder="Find documents…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Tooltip content="Upload documents">
            <Button variant="secondary" size="icon" asChild>
              <Link to="/upload">
                <Upload />
              </Link>
            </Button>
          </Tooltip>
          <Tooltip content={showLinks ? 'Hide near-duplicate links' : 'Show near-duplicate links on the map'}>
            <Button variant={showLinks ? 'default' : 'secondary'} size="icon" onClick={toggleLinks}>
              <Copy />
            </Button>
          </Tooltip>
          <Button onClick={() => recompute.mutate()} disabled={busy || (s?.counts.ready ?? 0) === 0}>
            {busy ? <Spinner className="border-white/30 border-t-white" /> : <RefreshCw />}
            {busy ? 'Clustering…' : 'Recompute'}
          </Button>
          {!panelOpen && (
            <Tooltip content="Show clusters">
              <Button variant="secondary" size="icon" onClick={() => setPanel(true)}>
                <PanelRightOpen />
              </Button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Near-duplicate links legend + threshold */}
      {showLinks && allPoints.length > 0 && (
        <div className="absolute bottom-3 left-28 flex items-center gap-3 rounded-xl border border-border bg-panel/90 px-3 py-2 text-xs shadow-xl backdrop-blur">
          <Copy className="size-3.5 text-muted" />
          {pairs.isLoading ? (
            <span className="flex items-center gap-2 text-muted">
              <Spinner /> Finding near-duplicates…
            </span>
          ) : (
            <>
              <span className="text-muted">
                <span className="font-medium text-fg">{links?.length ?? 0}</span> pairs ≥
              </span>
              <Slider
                className="w-28"
                min={pairs.data?.floor ?? 0.75}
                max={1}
                step={0.005}
                value={[threshold]}
                onValueChange={([v]) => setThreshold(v)}
              />
              <span className="w-9 font-mono text-fg">{threshold.toFixed(3)}</span>
              <Tooltip content="Only link documents written in the same language">
                <label className="flex items-center gap-1.5 text-muted">
                  <Switch checked={sameLang} onCheckedChange={setSameLang} />
                  Same language
                </label>
              </Tooltip>
              {(Object.keys(BANDS) as (keyof typeof BANDS)[]).map((b) => (
                <span key={b} className="flex items-center gap-1 text-muted">
                  <span className="h-0.5 w-3 rounded" style={{ background: BANDS[b].color }} />
                  {BANDS[b].label}
                </span>
              ))}
              <Link to="/duplicates" className="text-accent-2 hover:underline">
                Review →
              </Link>
            </>
          )}
        </div>
      )}

      {/* Floating cluster panel */}
      {panelOpen && (
        <div className="absolute bottom-3 right-3 top-[72px] flex w-80 flex-col overflow-hidden rounded-xl border border-border bg-panel/90 shadow-2xl backdrop-blur">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <span className="text-sm font-semibold">Clusters</span>
            <span className="text-xs text-muted">
              {visibleClusters.length}/{clusters.length}
            </span>
            {hidden.size > 0 && (
              <button className="ml-2 text-xs text-accent-2 hover:underline" onClick={() => setHidden(new Set())}>
                Show all
              </button>
            )}
            <button
              className="ml-auto rounded-md p-1 text-muted hover:bg-panel-2 hover:text-fg"
              onClick={() => setPanel(false)}
              title="Collapse"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
          <div className="scrollbar-thin min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {clusters.length === 0 && <div className="p-4 text-sm text-muted">No clusters yet.</div>}
            {clusters.map((c) => {
              const isHidden = hidden.has(c.id)
              const isSelected = selectedCluster === c.id
              return (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => !isHidden && setSelectedCluster(isSelected ? null : c.id)}
                  className={cn(
                    'group w-full cursor-pointer rounded-lg border px-3 py-2.5 text-left transition-colors',
                    isSelected ? 'border-accent/50 bg-accent/10' : 'border-transparent hover:bg-panel-2',
                    isHidden && 'opacity-45',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: clusterColor(c.id) }} />
                    <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', isHidden && 'line-through')}>{c.label}</span>
                    <span className="text-xs text-muted">{c.size}</span>
                    <Tooltip content={isHidden ? 'Show cluster' : 'Hide cluster'}>
                      <button
                        className={cn(
                          'rounded-md p-1 text-muted hover:bg-border hover:text-fg',
                          !isHidden && 'opacity-0 group-hover:opacity-100 focus:opacity-100',
                        )}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggle(c.id)
                        }}
                      >
                        {isHidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </button>
                    </Tooltip>
                    <Tooltip content="Delete all documents in this cluster">
                      <button
                        className="rounded-md p-1 text-muted opacity-0 hover:bg-rose-500/15 hover:text-rose-400 focus:opacity-100 group-hover:opacity-100 disabled:opacity-30"
                        disabled={deleteCluster.isPending}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (confirm(`Delete all ${c.size} document${c.size === 1 ? '' : 's'} in cluster "${c.label}"? This cannot be undone.`)) {
                            deleteCluster.mutate(c.id)
                          }
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </Tooltip>
                  </div>
                  {!isHidden && c.description && <p className="mt-1 line-clamp-2 pl-4.5 text-xs text-muted">{c.description}</p>}
                  {!isHidden && (
                    <div className="mt-1.5 flex flex-wrap gap-1 pl-4.5">
                      {c.keywords.slice(0, 4).map((k) => (
                        <span key={k} className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted">
                          {k}
                        </span>
                      ))}
                    </div>
                  )}
                  {isSelected && (
                    <Link
                      to={`/documents?clusterId=${c.id}`}
                      className="mt-2 block pl-4.5 text-xs text-accent-2 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      View documents →
                    </Link>
                  )}
                </div>
              )
            })}
          </div>
          {map.data?.run && (
            <div className="border-t border-border px-4 py-2.5 text-[11px] text-muted">
              {map.data.run.docCount} docs · min cluster size {map.data.run.params.minClusterSize} · {map.data.run.trigger} run{' '}
              {timeAgo(map.data.run.finishedAt)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
