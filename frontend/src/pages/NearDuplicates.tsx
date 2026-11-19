import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Columns2, Copy, Crown, EyeOff, RefreshCw, RotateCcw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { Badge, Button, Card, EmptyState, Input, Slider, Spinner, Switch, Tooltip } from '@/components/ui'
import { api, type Pair, type PairDoc, type PairsResult } from '@/lib/api'
import { BANDS, bandOf, canonicalOf, differentLanguage, groupPairs, languageName, pairKey, useDupThreshold, useSameLanguage } from '@/lib/pairs'
import { clusterColor, cn, docTitle, timeAgo } from '@/lib/utils'

const MAX_ROWS = 500

function Histogram({
  pairs,
  floor,
  threshold,
  onPick,
}: {
  pairs: Pair[]
  floor: number
  threshold: number
  onPick: (v: number) => void
}) {
  const step = 0.01
  const bins = useMemo(() => {
    const n = Math.round((1 - floor) / step)
    const counts = new Array<number>(n).fill(0)
    for (const p of pairs) counts[Math.min(n - 1, Math.max(0, Math.floor((p.score - floor) / step)))]++
    return counts.map((count, i) => ({ start: floor + i * step, count }))
  }, [pairs, floor])
  const max = Math.max(1, ...bins.map((b) => b.count))
  const pct = (v: number) => ((v - floor) / (1 - floor)) * 100

  return (
    <div>
      <div className="relative h-28">
        <div className="flex h-full items-end gap-px">
          {bins.map((b) => (
            <Tooltip key={b.start} content={`${b.start.toFixed(2)}–${(b.start + step).toFixed(2)}: ${b.count} pair${b.count === 1 ? '' : 's'}`}>
              <button
                className="relative h-full flex-1 cursor-pointer rounded-t-sm hover:bg-panel-2"
                onClick={() => onPick(Math.round(b.start * 1000) / 1000)}
              >
                <span
                  className="absolute inset-x-0 bottom-0 rounded-t-sm transition-opacity"
                  style={{
                    height: b.count ? `${Math.max(4, Math.sqrt(b.count / max) * 100)}%` : 0,
                    background: BANDS[bandOf(b.start)].color,
                    opacity: b.start + step <= threshold ? 0.25 : 0.9,
                  }}
                />
              </button>
            </Tooltip>
          ))}
        </div>
        <div className="pointer-events-none absolute inset-y-0 w-px bg-fg" style={{ left: `${pct(threshold)}%` }}>
          <span className="absolute -top-1 left-1 whitespace-nowrap rounded bg-fg px-1 font-mono text-[10px] text-bg">
            {threshold.toFixed(3)}
          </span>
        </div>
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-muted">
        {[floor, 0.85, 0.9, 0.95, 1].filter((v) => v >= floor).map((v) => (
          <span key={v} className="absolute -translate-x-1/2" style={{ left: `${pct(v)}%` }}>
            {v.toFixed(2)}
          </span>
        ))}
      </div>
    </div>
  )
}

function DocCell({ doc, id, cluster }: { doc?: PairDoc; id: string; cluster?: { id: number; label: string } }) {
  return (
    <div className="min-w-0">
      <Link to={`/documents/${id}`} className="block truncate font-medium hover:text-accent-2">
        {doc ? docTitle(doc) : id}
      </Link>
      <div className="flex items-center gap-1.5 truncate text-xs text-muted">
        {cluster && <span className="size-2 shrink-0 rounded-full" style={{ background: clusterColor(cluster.id) }} />}
        <span className="truncate">
          {doc?.name}
          {doc?.pageCount ? ` · ${doc.pageCount} p` : ''}
        </span>
        {doc?.language && (
          <Tooltip content={languageName(doc.language)}>
            <span className="shrink-0 rounded bg-panel-2 px-1 font-mono text-[10px] uppercase text-muted">
              {doc.language === 'und' ? '??' : doc.language}
            </span>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

function ScoreBadge({ score }: { score: number }) {
  const band = BANDS[bandOf(score)]
  return (
    <Tooltip content={band.label}>
      <span>
        <Badge tone={band.tone} className="font-mono">
          {score.toFixed(3)}
        </Badge>
      </span>
    </Tooltip>
  )
}

export function NearDuplicatesPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const pairsQ = useQuery({ queryKey: ['pairs'], queryFn: () => api.pairs(), staleTime: 60_000 })
  const map = useQuery({ queryKey: ['map'], queryFn: api.map, staleTime: 60_000 })
  const [threshold, setThreshold] = useDupThreshold()
  const [sameLang, setSameLang] = useSameLanguage()
  const [view, setView] = useState<'groups' | 'pairs'>('groups')
  const [showDismissed, setShowDismissed] = useState(false)
  const [search, setSearch] = useState('')

  const refresh = useMutation({
    mutationFn: () => api.pairs(true),
    onSuccess: (data) => qc.setQueryData(['pairs'], data),
  })
  const dismiss = useMutation({
    mutationFn: ({ a, b, dismissed }: { a: string; b: string; dismissed: boolean }) => api.dismissPair(a, b, dismissed),
    onSuccess: ({ dismissed }) => qc.setQueryData<PairsResult>(['pairs'], (old) => (old ? { ...old, dismissed } : old)),
  })

  const clusterOf = useMemo(() => {
    const labels = new Map((map.data?.run?.clusters ?? []).map((c) => [c.id, c.label]))
    const out = new Map<string, { id: number; label: string }>()
    for (const p of map.data?.points ?? []) {
      if (p.clusterId >= 0) out.set(p.id, { id: p.clusterId, label: labels.get(p.clusterId) ?? `Cluster ${p.clusterId}` })
    }
    return out
  }, [map.data])

  const data = pairsQ.data
  const dismissed = useMemo(() => data?.dismissed ?? {}, [data])
  const isDismissed = (p: Pair) => !!dismissed[pairKey(p.a, p.b)]
  const langOk = useMemo(
    () => (p: Pair) => !sameLang || !data || !differentLanguage(p, data.docs),
    [sameLang, data],
  )
  const crossLanguage = useMemo(
    () => (data ? data.pairs.filter((p) => p.score >= threshold && differentLanguage(p, data.docs)).length : 0),
    [data, threshold],
  )
  const live = useMemo(
    () => (data?.pairs ?? []).filter((p) => !dismissed[pairKey(p.a, p.b)] && langOk(p)),
    [data, dismissed, langOk],
  )
  const above = useMemo(() => live.filter((p) => p.score >= threshold), [live, threshold])
  const groups = useMemo(() => {
    if (!data) return []
    const scoreOf = new Map(above.map((p) => [pairKey(p.a, p.b), p.score]))
    return groupPairs(above)
      .map((ids) => {
        const keep = canonicalOf(ids, data.docs)
        const scores = ids.flatMap((x, i) => ids.slice(i + 1).map((y) => scoreOf.get(pairKey(x, y)) ?? 0))
        return { ids, keep, min: Math.min(...scores), max: Math.max(...scores) }
      })
      .sort((x, y) => y.ids.length - x.ids.length || y.max - x.max)
  }, [above, data])

  const q = search.trim().toLowerCase()
  const matches = (id: string) => {
    if (!q) return true
    const d = data?.docs[id]
    return `${d?.name ?? ''} ${d?.title ?? ''}`.toLowerCase().includes(q)
  }
  const rows = (showDismissed ? (data?.pairs ?? []).filter((p) => p.score >= threshold && langOk(p)) : above).filter(
    (p) => matches(p.a) || matches(p.b),
  )
  const groupRows = groups.filter((g) => g.ids.some(matches))
  const dismissedCount = Object.keys(dismissed).length

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Near-duplicates"
        subtitle={
          data
            ? `${data.docCount} documents · ${above.length} pair${above.length === 1 ? '' : 's'} ≥ ${threshold.toFixed(3)} · ${groups.length} group${groups.length === 1 ? '' : 's'} · computed ${timeAgo(data.computedAt)}`
            : 'Documents so similar that one could replace the other'
        }
        actions={
          <Button variant="secondary" onClick={() => refresh.mutate()} disabled={refresh.isPending || pairsQ.isLoading}>
            {refresh.isPending ? <Spinner /> : <RefreshCw />}
            Recompute
          </Button>
        }
      />
      {pairsQ.isLoading ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted">
          <Spinner />
          Comparing every document with its nearest neighbours…
        </div>
      ) : pairsQ.isError ? (
        <EmptyState icon={<Copy className="size-5" />} title="Could not load near-duplicates">
          {(pairsQ.error as Error).message}
        </EmptyState>
      ) : (
        <div className="scrollbar-thin min-h-0 flex-1 space-y-5 overflow-y-auto px-8 py-5">
          <Card className="p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-2xl">
                <div className="text-sm font-semibold">Similarity threshold</div>
                <p className="mt-1 text-xs text-muted">
                  Whole-document cosine similarity of each document with its {data?.neighbours} nearest neighbours. True
                  duplicates usually form a separate bump on the right — put the threshold in the valley before it. Click a bar
                  to set it.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Slider
                  className="w-56"
                  min={data?.floor ?? 0.75}
                  max={1}
                  step={0.005}
                  value={[threshold]}
                  onValueChange={([v]) => setThreshold(v)}
                />
                <span className="w-12 font-mono text-sm">{threshold.toFixed(3)}</span>
              </div>
            </div>
            <Histogram pairs={live} floor={data?.floor ?? 0.75} threshold={threshold} onPick={setThreshold} />
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted">
              {(Object.keys(BANDS) as (keyof typeof BANDS)[]).map((b) => (
                <span key={b} className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-sm" style={{ background: BANDS[b].color }} />
                  {BANDS[b].label}
                  {BANDS[b].min > 0 ? ` ≥ ${BANDS[b].min}` : ''}
                </span>
              ))}
            </div>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1 rounded-lg border border-border bg-panel p-1">
              {(['groups', 'pairs'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={cn('rounded-md px-3 py-1 text-xs capitalize', view === v ? 'bg-panel-2 text-fg' : 'text-muted hover:text-fg')}
                >
                  {v}
                </button>
              ))}
            </div>
            <div className="relative w-72">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted" />
              <Input className="pl-8" placeholder="Filter by name or title…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Tooltip content="Hide pairs whose documents are written in different languages (documents with an unknown language are kept)">
              <label className="flex items-center gap-2 text-xs text-muted">
                <Switch checked={sameLang} onCheckedChange={setSameLang} />
                Same language only
                {crossLanguage > 0 && (
                  <span className="text-muted/80">
                    ({crossLanguage} cross-language pair{crossLanguage === 1 ? '' : 's'} {sameLang ? 'hidden' : 'shown'})
                  </span>
                )}
              </label>
            </Tooltip>
            {view === 'pairs' && dismissedCount > 0 && (
              <label className="flex items-center gap-2 text-xs text-muted">
                <Switch checked={showDismissed} onCheckedChange={setShowDismissed} />
                Show dismissed ({dismissedCount})
              </label>
            )}
          </div>

          {view === 'groups' ? (
            groupRows.length === 0 ? (
              <EmptyState icon={<Copy className="size-5" />} title="No near-duplicate groups at this threshold">
                Lower the threshold to see less similar documents.
              </EmptyState>
            ) : (
              <div className="grid gap-4 xl:grid-cols-2">
                {groupRows.map((g) => (
                  <Card key={g.ids.join()} className="overflow-hidden">
                    <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                      <span className="text-sm font-semibold">{g.ids.length} documents</span>
                      <ScoreBadge score={g.min} />
                      {g.max !== g.min && <span className="text-xs text-muted">to {g.max.toFixed(3)}</span>}
                      <span className="ml-auto text-[11px] text-muted">every pair ≥ {threshold.toFixed(3)}</span>
                    </div>
                    <div className="divide-y divide-border/60">
                      {[g.keep, ...g.ids.filter((id) => id !== g.keep)].map((id) => {
                        const isKeep = id === g.keep
                        const score = data?.pairs.find((p) => pairKey(p.a, p.b) === pairKey(g.keep, id))?.score
                        return (
                          <div key={id} className={cn('flex items-center gap-3 px-4 py-2.5 text-sm', isKeep && 'bg-accent/5')}>
                            <div className="min-w-0 flex-1">
                              <DocCell id={id} doc={data?.docs[id]} cluster={clusterOf.get(id)} />
                            </div>
                            {isKeep ? (
                              <Tooltip content="Suggested to keep: the most recently uploaded, then the longest document">
                                <span>
                                  <Badge tone="accent">
                                    <Crown className="size-3" /> Keep
                                  </Badge>
                                </span>
                              </Tooltip>
                            ) : (
                              <>
                                {score !== undefined && <ScoreBadge score={score} />}
                                <Tooltip content="Compare side by side with the suggested document">
                                  <Button size="sm" variant="secondary" onClick={() => navigate(`/compare/${g.keep}/${id}`)}>
                                    <Columns2 /> Compare
                                  </Button>
                                </Tooltip>
                                <Tooltip content="Not a duplicate of the suggested document">
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="size-8"
                                    disabled={dismiss.isPending}
                                    onClick={() => dismiss.mutate({ a: g.keep, b: id, dismissed: true })}
                                  >
                                    <EyeOff />
                                  </Button>
                                </Tooltip>
                              </>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </Card>
                ))}
              </div>
            )
          ) : rows.length === 0 ? (
            <EmptyState icon={<Copy className="size-5" />} title="No pairs at this threshold">
              Lower the threshold to see less similar documents.
            </EmptyState>
          ) : (
            <Card className="overflow-hidden">
              <table className="w-full table-fixed text-sm">
                <thead className="bg-panel text-left text-xs text-muted">
                  <tr className="border-b border-border">
                    <th className="px-5 py-3 font-medium">Document A</th>
                    <th className="px-3 py-3 font-medium">Document B</th>
                    <th className="w-28 px-3 py-3 font-medium">Similarity</th>
                    <th className="w-44 px-3 py-3 font-medium">Cluster</th>
                    <th className="w-48 px-5 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, MAX_ROWS).map((p) => {
                    const ca = clusterOf.get(p.a)
                    const cb = clusterOf.get(p.b)
                    const off = isDismissed(p)
                    return (
                      <tr key={pairKey(p.a, p.b)} className={cn('border-b border-border/60 hover:bg-panel-2/60', off && 'opacity-50')}>
                        <td className="px-5 py-2.5">
                          <DocCell id={p.a} doc={data?.docs[p.a]} cluster={ca} />
                        </td>
                        <td className="px-3 py-2.5">
                          <DocCell id={p.b} doc={data?.docs[p.b]} cluster={cb} />
                        </td>
                        <td className="px-3 py-2.5">
                          <ScoreBadge score={p.score} />
                        </td>
                        <td className="px-3 py-2.5 text-xs text-muted">
                          {ca && cb && ca.id === cb.id ? (
                            <span className="flex items-center gap-1.5 truncate">
                              <span className="size-2 shrink-0 rounded-full" style={{ background: clusterColor(ca.id) }} />
                              <span className="truncate">{ca.label}</span>
                            </span>
                          ) : (
                            <Tooltip content="The two documents are in different topic clusters">
                              <span className="text-amber-300">Different clusters</span>
                            </Tooltip>
                          )}
                        </td>
                        <td className="px-5 py-2.5">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button size="sm" variant="secondary" onClick={() => navigate(`/compare/${p.a}/${p.b}`)}>
                              <Columns2 /> Compare
                            </Button>
                            <Tooltip content={off ? 'Restore: flag as near-duplicate again' : 'Dismiss: not a duplicate'}>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-8"
                                disabled={dismiss.isPending}
                                onClick={() => dismiss.mutate({ a: p.a, b: p.b, dismissed: !off })}
                              >
                                {off ? <RotateCcw /> : <EyeOff />}
                              </Button>
                            </Tooltip>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {rows.length > MAX_ROWS && (
                <div className="px-5 py-3 text-xs text-muted">
                  Showing the top {MAX_ROWS} of {rows.length} pairs. Raise the threshold or filter to narrow down.
                </div>
              )}
            </Card>
          )}
        </div>
      )}
    </div>
  )
}
