import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, RotateCcw, Search, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { StatusBadge } from '@/components/StatusBadge'
import { Button, Card, EmptyState, Input, Tooltip } from '@/components/ui'
import { ACTIVE_STATUSES, api, type DocStatus } from '@/lib/api'
import { languageName } from '@/lib/pairs'
import { clusterColor, cn, docTitle, formatBytes, timeAgo } from '@/lib/utils'

const PAGE = 25
const FILTERS: (DocStatus | '')[] = ['', 'ready', 'queued', 'extracting', 'cleaning', 'embedding', 'failed']

export function DocumentsPage() {
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? '')
  const status = params.get('status') ?? ''
  const clusterId = params.get('clusterId')
  const batchId = params.get('batchId') ?? undefined
  const offset = Number(params.get('offset') ?? 0)
  const qc = useQueryClient()

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k)
      else next.set(k, v)
    }
    if (!('offset' in patch)) next.delete('offset')
    setParams(next)
  }

  const docs = useQuery({
    queryKey: ['documents', status, clusterId, batchId, params.get('q'), offset],
    queryFn: () =>
      api.documents({
        status: status || undefined,
        clusterId: clusterId !== null ? Number(clusterId) : undefined,
        batchId,
        q: params.get('q') ?? undefined,
        limit: PAGE,
        offset,
      }),
    refetchInterval: (query) => (query.state.data?.items.some((d) => ACTIVE_STATUSES.includes(d.status)) ? 3_000 : false),
  })
  const map = useQuery({ queryKey: ['map'], queryFn: api.map, staleTime: 30_000 })
  const clusterLabel = (id?: number | null) =>
    id === null || id === undefined ? '—' : id < 0 ? 'Unclustered' : (map.data?.run?.clusters.find((c) => c.id === id)?.label ?? `#${id}`)

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['documents'] })
    void qc.invalidateQueries({ queryKey: ['stats'] })
  }
  const refreshAll = () => {
    refresh()
    void qc.invalidateQueries({ queryKey: ['map'] })
    void qc.invalidateQueries({ queryKey: ['pairs'] })
  }
  const reprocess = useMutation({ mutationFn: api.reprocess, onSuccess: refresh })
  const remove = useMutation({ mutationFn: api.remove, onSuccess: refreshAll })

  // Selection is tied to the active filters (not the page), so it survives paging but resets on filter change.
  const qParam = params.get('q') ?? ''
  const filterKey = [status, clusterId ?? '', batchId ?? '', qParam].join('|')
  const [sel, setSel] = useState<{ key: string; ids: Set<string>; all: boolean }>({ key: filterKey, ids: new Set(), all: false })
  const selection = sel.key === filterKey ? sel : { key: filterKey, ids: new Set<string>(), all: false }
  const hasFilter = Boolean(status || clusterId !== null || batchId || qParam)
  const activeFilter = {
    status: status || undefined,
    clusterId: clusterId !== null ? Number(clusterId) : undefined,
    batchId,
    q: qParam || undefined,
  }
  const clearSelection = () => setSel({ key: filterKey, ids: new Set(), all: false })
  const toggle = (id: string) => {
    const ids = new Set(selection.ids)
    if (ids.has(id)) ids.delete(id)
    else ids.add(id)
    setSel({ key: filterKey, ids, all: false })
  }
  const pageIds = docs.data?.items.map((d) => d.id) ?? []
  const pageAllSelected = pageIds.length > 0 && (selection.all || pageIds.every((id) => selection.ids.has(id)))
  const pageSomeSelected = !pageAllSelected && pageIds.some((id) => selection.ids.has(id))
  const togglePage = () => {
    const ids = new Set(selection.ids)
    if (pageAllSelected) pageIds.forEach((id) => ids.delete(id))
    else pageIds.forEach((id) => ids.add(id))
    setSel({ key: filterKey, ids, all: false })
  }

  const bulk = useMutation({
    mutationFn: api.bulkDelete,
    onSuccess: (r) => {
      clearSelection()
      if (offset > 0) update({ offset: null })
      refreshAll()
      if (r.notFound > 0) console.info(`${r.notFound} document(s) were already gone`)
    },
    onError: (e) => alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`),
  })

  const total = docs.data?.total ?? 0
  const selectedCount = selection.all ? total : selection.ids.size
  const deleteSelected = () => {
    if (!selectedCount) return
    if (!confirm(`Delete ${selectedCount} document${selectedCount === 1 ? '' : 's'}? This cannot be undone.`)) return
    bulk.mutate(selection.all ? { filter: activeFilter } : { ids: [...selection.ids] })
  }
  const deleteCluster = () => {
    if (clusterId === null) return
    if (!confirm(`Delete all ${total} document${total === 1 ? '' : 's'} in cluster "${clusterLabel(Number(clusterId))}"? This cannot be undone.`)) return
    bulk.mutate({ filter: { clusterId: Number(clusterId) } })
  }
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Documents"
        subtitle={
          clusterId !== null ? (
            <span className="flex items-center gap-2">
              <span className="size-2 rounded-full" style={{ background: clusterColor(Number(clusterId)) }} />
              Cluster: {clusterLabel(Number(clusterId))}
              <button className="text-accent-2 hover:underline" onClick={() => update({ clusterId: null })}>
                clear
              </button>
            </span>
          ) : (
            `${total} document${total === 1 ? '' : 's'}`
          )
        }
        actions={
          clusterId !== null && total > 0 ? (
            <Button variant="danger" size="sm" disabled={bulk.isPending} onClick={deleteCluster}>
              <Trash2 /> Delete cluster ({total})
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-wrap items-center gap-3 px-8 pt-5">
        <form
          className="relative w-72"
          onSubmit={(e) => {
            e.preventDefault()
            update({ q })
          }}
        >
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted" />
          <Input className="pl-8" placeholder="Search name or title…" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
        <div className="flex gap-1 rounded-lg border border-border bg-panel p-1">
          {FILTERS.map((f) => (
            <button
              key={f || 'all'}
              onClick={() => update({ status: f })}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs capitalize',
                status === f ? 'bg-panel-2 text-fg' : 'text-muted hover:text-fg',
              )}
            >
              {f || 'all'}
            </button>
          ))}
        </div>
      </div>
      {selectedCount > 0 && (
        <div className="mx-8 mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-accent/40 bg-accent/10 px-4 py-2 text-sm">
          <span className="font-medium">
            {selectedCount} selected{selection.all ? ' (all matching)' : ''}
          </span>
          {!selection.all && hasFilter && pageAllSelected && total > selection.ids.size && (
            <button className="text-accent-2 hover:underline" onClick={() => setSel({ key: filterKey, ids: new Set(), all: true })}>
              Select all {total} matching
            </button>
          )}
          <button className="text-muted hover:text-fg hover:underline" onClick={clearSelection}>
            Clear
          </button>
          <div className="flex-1" />
          <Button variant="danger" size="sm" disabled={bulk.isPending} onClick={deleteSelected}>
            <Trash2 /> {bulk.isPending ? 'Deleting…' : `Delete ${selectedCount}`}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 px-8 py-5">
        <Card className="flex h-full flex-col overflow-hidden">
          <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-panel text-left text-xs text-muted">
                <tr className="border-b border-border">
                  <th className="w-10 py-3 pl-5">
                    <input
                      type="checkbox"
                      aria-label="Select page"
                      className="size-4 cursor-pointer accent-accent"
                      checked={pageAllSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = pageSomeSelected
                      }}
                      onChange={togglePage}
                    />
                  </th>
                  <th className="px-3 py-3 font-medium">Document</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 font-medium">Language</th>
                  <th className="px-3 py-3 font-medium">Cluster</th>
                  <th className="px-3 py-3 font-medium">Pages</th>
                  <th className="px-3 py-3 font-medium">Size</th>
                  <th className="px-3 py-3 font-medium">Uploaded</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {docs.data?.items.map((d) => {
                  const checked = selection.all || selection.ids.has(d.id)
                  return (
                  <tr key={d.id} className={cn('border-b border-border/60 hover:bg-panel-2/60', checked && 'bg-accent/5')}>
                    <td className="w-10 py-2.5 pl-5">
                      <input
                        type="checkbox"
                        aria-label={`Select ${d.name}`}
                        className="size-4 cursor-pointer accent-accent"
                        checked={checked}
                        disabled={selection.all}
                        onChange={() => toggle(d.id)}
                      />
                    </td>
                    <td className="max-w-md px-3 py-2.5">
                      <Link to={`/documents/${d.id}`} className="block truncate font-medium hover:text-accent-2">
                        {docTitle(d)}
                      </Link>
                      <div className="truncate text-xs text-muted">{d.name}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <Tooltip content={d.error ?? d.status}>
                        <span>
                          <StatusBadge status={d.status} />
                        </span>
                      </Tooltip>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted">
                      {d.language ? (
                        <Tooltip content={languageName(d.language)}>
                          <span className="rounded bg-panel-2 px-1.5 py-0.5 font-mono uppercase">
                            {d.language === 'und' ? '??' : d.language}
                          </span>
                        </Tooltip>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="max-w-48 px-3 py-2.5">
                      <span className="flex items-center gap-1.5 truncate text-xs text-muted">
                        {d.clusterId !== null && d.clusterId !== undefined && (
                          <span className="size-2 shrink-0 rounded-full" style={{ background: clusterColor(d.clusterId) }} />
                        )}
                        <span className="truncate">{clusterLabel(d.clusterId)}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted">{d.pageCount ?? '—'}</td>
                    <td className="px-3 py-2.5 text-xs text-muted">{formatBytes(d.size)}</td>
                    <td className="px-3 py-2.5 text-xs text-muted">{timeAgo(d.createdAt)}</td>
                    <td className="px-5 py-2.5">
                      <div className="flex justify-end gap-1">
                        <Tooltip content="Reprocess">
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={ACTIVE_STATUSES.includes(d.status) && d.status !== 'queued'}
                            onClick={() => reprocess.mutate(d.id)}
                          >
                            <RotateCcw />
                          </Button>
                        </Tooltip>
                        <Tooltip content="Delete">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              if (confirm(`Delete ${d.name}?`)) remove.mutate(d.id)
                            }}
                          >
                            <Trash2 />
                          </Button>
                        </Tooltip>
                      </div>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
            {docs.data && docs.data.items.length === 0 && <EmptyState title="No documents match" />}
          </div>
          <div className="flex items-center justify-between border-t border-border px-5 py-2.5 text-xs text-muted">
            <span>
              {total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE, total)} of {total}
            </span>
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => update({ offset: String(Math.max(0, offset - PAGE)) })}>
                <ChevronLeft /> Prev
              </Button>
              <Button variant="ghost" size="sm" disabled={offset + PAGE >= total} onClick={() => update({ offset: String(offset + PAGE) })}>
                Next <ChevronRight />
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
