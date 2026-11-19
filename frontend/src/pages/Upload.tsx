import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CloudUpload, FileText, X } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { Badge, Button, Card, CardHeader, CardTitle, Input, Progress } from '@/components/ui'
import { api, type UploadResult } from '@/lib/api'
import { cn, formatBytes, timeAgo } from '@/lib/utils'

const ACCEPT = ['.pdf', '.docx', '.txt', '.md']
const FILES_PER_REQUEST = 8
const PARALLEL_REQUESTS = 3

function accepted(f: File) {
  return ACCEPT.some((ext) => f.name.toLowerCase().endsWith(ext))
}

export function UploadPage() {
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [label, setLabel] = useState('')
  const [drag, setDrag] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [sentBytes, setSentBytes] = useState(0)
  const [batchId, setBatchId] = useState<string | null>(null)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const addFiles = useCallback((list: FileList | File[]) => {
    const incoming = Array.from(list).filter(accepted)
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`))
      return [...prev, ...incoming.filter((f) => !seen.has(`${f.name}:${f.size}`))]
    })
  }, [])

  const totalBytes = files.reduce((s, f) => s + f.size, 0)

  const progress = useQuery({
    queryKey: ['batch', batchId],
    queryFn: () => api.batch(batchId!),
    enabled: !!batchId,
    refetchInterval: (q) => (q.state.data?.done && !uploading ? false : 2_000),
  })
  const batches = useQuery({ queryKey: ['batches'], queryFn: api.batches })

  const start = async () => {
    setUploading(true)
    setError(null)
    setSentBytes(0)
    const combined: UploadResult = { accepted: [], rejected: [] }
    try {
      const batch = await api.createBatch(label.trim() || undefined)
      setBatchId(batch.id)
      const chunks: File[][] = []
      for (let i = 0; i < files.length; i += FILES_PER_REQUEST) chunks.push(files.slice(i, i + FILES_PER_REQUEST))
      let next = 0
      const worker = async () => {
        while (next < chunks.length) {
          const chunk = chunks[next++]
          const r = await api.upload(batch.id, chunk)
          combined.accepted.push(...r.accepted)
          combined.rejected.push(...r.rejected)
          setSentBytes((b) => b + chunk.reduce((s, f) => s + f.size, 0))
          setResult({ ...combined })
        }
      }
      await Promise.all(Array.from({ length: Math.min(PARALLEL_REQUESTS, chunks.length) }, worker))
      setFiles([])
      void qc.invalidateQueries({ queryKey: ['stats'] })
      void qc.invalidateQueries({ queryKey: ['batches'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }

  const p = progress.data
  const processed = p ? (p.counts.ready ?? 0) + (p.counts.failed ?? 0) : 0

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader title="Upload documents" subtitle="Bulk upload PDF, DOCX or TXT files. Headers and footers are removed before embedding." />
      <div className="grid gap-6 px-8 py-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-3 border-2 border-dashed p-12 text-center transition-colors',
              drag ? 'border-accent bg-accent/5' : 'border-border hover:border-muted',
            )}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDrag(true)
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDrag(false)
              addFiles(e.dataTransfer.files)
            }}
          >
            <div className="rounded-2xl bg-gradient-to-br from-accent/20 to-accent-2/20 p-4 text-accent-2">
              <CloudUpload className="size-7" />
            </div>
            <div className="text-sm font-medium">Drop files here or click to browse</div>
            <div className="text-xs text-muted">{ACCEPT.join(', ')} · many files at once</div>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPT.join(',')}
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </Card>

          {files.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>
                  {files.length} file{files.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Input className="w-56" placeholder="Batch label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
                  <Button variant="ghost" onClick={() => setFiles([])} disabled={uploading}>
                    Clear
                  </Button>
                  <Button onClick={() => void start()} disabled={uploading}>
                    <CloudUpload /> {uploading ? 'Uploading…' : 'Upload batch'}
                  </Button>
                </div>
              </CardHeader>
              {uploading && <Progress className="rounded-none" value={(sentBytes / Math.max(totalBytes, 1)) * 100} />}
              <ul className="scrollbar-thin max-h-80 divide-y divide-border/60 overflow-y-auto">
                {files.map((f) => (
                  <li key={`${f.name}:${f.size}`} className="flex items-center gap-3 px-5 py-2 text-sm">
                    <FileText className="size-4 text-muted" />
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    <span className="text-xs text-muted">{formatBytes(f.size)}</span>
                    {!uploading && (
                      <button className="text-muted hover:text-fg" onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}>
                        <X className="size-4" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}

          {batchId && p && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {p.done && !uploading ? <CheckCircle2 className="size-4 text-emerald-400" /> : null}
                  Batch {p.label ?? batchId.slice(0, 8)}
                </CardTitle>
                <span className="text-xs text-muted">
                  {processed} / {p.total} processed
                </span>
              </CardHeader>
              <div className="space-y-4 p-5">
                <Progress value={(processed / Math.max(p.total, 1)) * 100} />
                <div className="flex flex-wrap gap-2">
                  {Object.entries(p.counts).map(([s, n]) => (
                    <Badge key={s} tone={s === 'ready' ? 'success' : s === 'failed' ? 'danger' : 'info'}>
                      {s}: {n}
                    </Badge>
                  ))}
                </div>
                {result && result.rejected.length > 0 && (
                  <div className="text-xs text-rose-300">
                    {result.rejected.length} rejected: {result.rejected.map((r) => `${r.name} (${r.reason})`).join(', ')}
                  </div>
                )}
                {p.done && !uploading && (
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" asChild>
                      <Link to={`/documents?batchId=${batchId}`}>View documents</Link>
                    </Button>
                    <Button size="sm" asChild>
                      <Link to="/">Open cluster map</Link>
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Recent batches</CardTitle>
          </CardHeader>
          <ul className="divide-y divide-border/60">
            {(batches.data ?? []).length === 0 && <li className="px-5 py-4 text-sm text-muted">No batches yet.</li>}
            {(batches.data ?? []).map((b) => (
              <li key={b.id}>
                <Link to={`/documents?batchId=${b.id}`} className="flex items-center justify-between px-5 py-2.5 text-sm hover:bg-panel-2">
                  <span className="truncate">{b.label ?? b.id.slice(0, 8)}</span>
                  <span className="text-xs text-muted">{timeAgo(b.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
