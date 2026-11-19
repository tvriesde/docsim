import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowLeftRight,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  MessageSquare,
  RefreshCw,
  Send,
  Sparkles,
  X,
} from 'lucide-react'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Badge, Button, EmptyState, Spinner, Tooltip } from '@/components/ui'
import { api, type ChatMessage, type CompareResult, type DocSummary } from '@/lib/api'
import { cn, docTitle, scoreColor } from '@/lib/utils'

const matchColor = (i: number) => `hsl(${(i * 47 + 190) % 360} 80% 62%)`

/** Minimal formatting for LLM replies: paragraphs, bullet lists and **bold**. */
function RichText({ text }: { text: string }) {
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
    )
  const blocks: ReactNode[] = []
  let list: string[] = []
  const flushList = () => {
    if (list.length) {
      blocks.push(
        <ul key={blocks.length} className="ml-4 list-disc space-y-0.5">
          {list.map((l, i) => (
            <li key={i}>{inline(l)}</li>
          ))}
        </ul>,
      )
    }
    list = []
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line)
    if (m) {
      list.push(m[1])
      continue
    }
    flushList()
    if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line.replace(/^#+\s*/, ''))}</p>)
  }
  flushList()
  return <div className="space-y-2">{blocks}</div>
}

function DocColumn({
  side,
  doc,
  passages,
  matchOf,
  matches,
  active,
  hover,
  onActivate,
  onHover,
}: {
  side: 'a' | 'b'
  doc: DocSummary
  passages: string[]
  matchOf: Map<number, number>
  matches: CompareResult['matches']
  active: number | null
  hover: number | null
  onActivate: (match: number) => void
  onHover: (match: number | null) => void
}) {
  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden border-r border-border">
      <div className="flex items-center gap-3 border-b border-border bg-panel px-5 py-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent/20 text-xs font-bold text-accent">
          {side.toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{docTitle(doc)}</div>
          <div className="truncate text-[11px] text-muted">
            {doc.name}
            {doc.pageCount ? ` · ${doc.pageCount} pages` : ''}
          </div>
        </div>
        <Tooltip content="Open original">
          <button className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg" onClick={() => void api.openFile(doc.id)}>
            <ExternalLink className="size-4" />
          </button>
        </Tooltip>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto max-w-3xl space-y-1">
          {passages.map((p, i) => {
            const m = matchOf.get(i)
            if (m === undefined) {
              return (
                <div key={i} className="whitespace-pre-wrap rounded-md px-3 py-1.5 text-[13px] leading-relaxed text-fg/75">
                  {p}
                </div>
              )
            }
            const color = matchColor(m)
            const isActive = active === m
            const isHover = hover === m
            return (
              <div
                key={i}
                id={`p${side}-${i}`}
                onClick={() => onActivate(m)}
                onMouseEnter={() => onHover(m)}
                onMouseLeave={() => onHover(null)}
                className={cn(
                  'relative cursor-pointer whitespace-pre-wrap rounded-md border-l-[3px] py-1.5 pl-3 pr-16 text-[13px] leading-relaxed text-fg transition-all',
                  isActive && 'ring-1 ring-white/40',
                )}
                style={{
                  borderColor: color,
                  background: `color-mix(in srgb, ${color} ${isActive ? 22 : isHover ? 16 : 9}%, transparent)`,
                }}
              >
                <span
                  className="absolute right-2 top-1.5 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold"
                  style={{ color, background: 'rgb(11 13 18 / 0.7)' }}
                >
                  #{m + 1} · {matches[m].score.toFixed(2)}
                </span>
                {p}
                {isActive && matches[m].note && (
                  <div className="mt-2 flex items-start gap-1.5 whitespace-normal rounded border border-border bg-panel/80 px-2 py-1.5 text-xs text-muted">
                    <Sparkles className="mt-0.5 size-3 shrink-0 text-accent-2" />
                    {matches[m].note}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

const SUGGESTIONS = [
  'Why are these documents similar?',
  'What are the most important differences?',
  'Which sections are (almost) identical?',
  'Could one replace the other?',
]

function ChatPanel({ a, b, onClose }: { a: string; b: string; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const send = useMutation({
    mutationFn: (history: ChatMessage[]) => api.compareChat(a, b, history),
    onSuccess: (res) => setMessages((m) => [...m, { role: 'assistant', content: res.reply }]),
  })

  useEffect(() => {
    setMessages([])
  }, [a, b])
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, send.isPending])

  const submit = (text: string) => {
    const t = text.trim()
    if (!t || send.isPending) return
    const next = [...messages, { role: 'user' as const, content: t }]
    setMessages(next)
    setInput('')
    send.mutate(next)
  }

  return (
    <aside className="flex w-[380px] shrink-0 flex-col overflow-hidden bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <MessageSquare className="size-4 text-accent-2" />
        <span className="text-sm font-semibold">Ask the AI</span>
        {messages.length > 0 && (
          <button className="ml-2 text-[11px] text-muted hover:text-fg" onClick={() => setMessages([])}>
            Clear
          </button>
        )}
        <button className="ml-auto rounded-md p-1 text-muted hover:bg-panel-2 hover:text-fg" onClick={onClose} title="Hide chat">
          <X className="size-4" />
        </button>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-[13px] leading-relaxed">
        {messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-xs text-muted">Ask anything about how these two documents relate. The AI reads both documents.</p>
            <div className="flex flex-col gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => submit(s)}
                  className="rounded-lg border border-border px-3 py-2 text-left text-xs text-fg/90 hover:border-accent/50 hover:bg-accent/10"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="ml-8 rounded-xl rounded-br-sm bg-accent/20 px-3 py-2 text-fg">
              {m.content}
            </div>
          ) : (
            <div key={i} className="flex gap-2">
              <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-panel-2 text-accent-2">
                <Bot className="size-3.5" />
              </div>
              <div className="min-w-0 flex-1 rounded-xl rounded-tl-sm bg-panel-2 px-3 py-2 text-fg/90">
                <RichText text={m.content} />
              </div>
            </div>
          ),
        )}
        {send.isPending && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner /> Thinking…
          </div>
        )}
        {send.error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{send.error.message}</div>}
        <div ref={endRef} />
      </div>
      <form
        className="flex items-end gap-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit(input)
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit(input)
            }
          }}
          rows={2}
          placeholder="Why are these similar?"
          className="scrollbar-thin max-h-40 min-h-[40px] flex-1 resize-y rounded-lg border border-border bg-panel-2 px-3 py-2 text-sm text-fg placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
        />
        <Button type="submit" size="icon" disabled={!input.trim() || send.isPending}>
          <Send />
        </Button>
      </form>
    </aside>
  )
}

function AnalysisStrip({ data }: { data: CompareResult }) {
  const [open, setOpen] = useState(true)
  const an = data.analysis
  return (
    <div className="border-b border-border bg-panel/60">
      <button className="flex w-full items-center gap-2 px-5 py-2 text-left" onClick={() => setOpen((v) => !v)}>
        <Sparkles className="size-3.5 text-accent-2" />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">AI analysis</span>
        {an?.verdict && <Badge tone="accent">{an.verdict}</Badge>}
        {!open && an && <span className="min-w-0 flex-1 truncate text-xs text-muted">{an.overview}</span>}
        <span className="ml-auto text-muted">{open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}</span>
      </button>
      {open && (
        <div className="scrollbar-thin max-h-[32vh] overflow-y-auto px-5 pb-4">
          {!an ? (
            <div className="text-xs text-rose-300">AI analysis failed: {data.analysisError ?? 'unknown error'}. Similar passages are still shown.</div>
          ) : (
            <div className="grid gap-5 text-[13px] lg:grid-cols-[1.4fr_1fr_1fr]">
              <p className="leading-relaxed text-fg/90">{an.overview}</p>
              <div>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-300/90">Similar</div>
                <ul className="space-y-1.5">
                  {an.similarities.map((s, i) => (
                    <li key={i} className="text-xs leading-relaxed text-fg/85">
                      <span className="font-medium text-fg">{s.topic}</span> — {s.detail}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-300/90">Different</div>
                <ul className="space-y-1.5">
                  {an.differences.map((s, i) => (
                    <li key={i} className="text-xs leading-relaxed text-fg/85">
                      <span className="font-medium text-fg">{s.topic}</span> — {s.detail}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ComparePage() {
  const { a = '', b = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  const [chatOpen, setChatOpen] = useState(true)
  const [active, setActive] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const cmp = useQuery({
    queryKey: ['compare', a, b],
    queryFn: () => api.compare(a, b),
    staleTime: Infinity,
    retry: false,
  })

  useEffect(() => {
    setActive(null)
  }, [a, b])

  const data = cmp.data
  const matchA = new Map((data?.matches ?? []).map((m, i) => [m.a, i]))
  const matchB = new Map((data?.matches ?? []).map((m, i) => [m.b, i]))
  const count = data?.matches.length ?? 0

  const activate = (m: number) => {
    setActive(m)
    const match = data?.matches[m]
    if (!match) return
    document.getElementById(`pa-${match.a}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    document.getElementById(`pb-${match.b}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  const step = (d: number) => count && activate(active === null ? (d > 0 ? 0 : count - 1) : (active + d + count) % count)

  const refresh = async () => {
    setRefreshing(true)
    try {
      qc.setQueryData(['compare', a, b], await api.compare(a, b, true))
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-panel px-3 py-2">
        <button onClick={() => navigate(-1)} className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg" title="Back">
          <ArrowLeft className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="truncate">{data ? docTitle(data.a) : 'Comparing documents…'}</span>
            {data && (
              <>
                <Tooltip content="Swap sides">
                  <button className="shrink-0 rounded p-1 text-muted hover:bg-panel-2 hover:text-fg" onClick={() => navigate(`/compare/${b}/${a}`, { replace: true })}>
                    <ArrowLeftRight className="size-3.5" />
                  </button>
                </Tooltip>
                <span className="truncate">{docTitle(data.b)}</span>
              </>
            )}
          </div>
        </div>
        {data && (
          <>
            <Badge tone="neutral">
              Overall
              <span className="font-mono" style={{ color: scoreColor(data.score) }}>
                {data.score.toFixed(3)}
              </span>
            </Badge>
            <div className="flex items-center gap-1 rounded-lg border border-border bg-panel-2 px-1 py-0.5 text-xs text-muted">
              <button className="rounded p-1 hover:text-fg disabled:opacity-40" onClick={() => step(-1)} disabled={!count}>
                <ChevronLeft className="size-4" />
              </button>
              <span className="min-w-24 text-center">
                {count === 0 ? 'No similar parts' : active === null ? `${count} similar parts` : `Similar part ${active + 1}/${count}`}
              </span>
              <button className="rounded p-1 hover:text-fg disabled:opacity-40" onClick={() => step(1)} disabled={!count}>
                <ChevronRight className="size-4" />
              </button>
            </div>
            <Tooltip content="Re-run the AI analysis">
              <Button variant="ghost" size="icon" onClick={() => void refresh()} disabled={refreshing}>
                {refreshing ? <Spinner /> : <RefreshCw />}
              </Button>
            </Tooltip>
          </>
        )}
        {!chatOpen && (
          <Button variant="secondary" size="sm" onClick={() => setChatOpen(true)}>
            <MessageSquare /> Ask the AI
          </Button>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-r border-border">
          {cmp.isLoading ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted">
              <Spinner />
              Matching passages and analyzing with GPT… this can take up to a minute.
            </div>
          ) : cmp.error || !data ? (
            <EmptyState title="Comparison failed">{cmp.error?.message}</EmptyState>
          ) : (
            <>
              <AnalysisStrip data={data} />
              <div className="flex min-h-0 flex-1">
                <DocColumn
                  side="a"
                  doc={data.a}
                  passages={data.passagesA}
                  matchOf={matchA}
                  matches={data.matches}
                  active={active}
                  hover={hover}
                  onActivate={activate}
                  onHover={setHover}
                />
                <DocColumn
                  side="b"
                  doc={data.b}
                  passages={data.passagesB}
                  matchOf={matchB}
                  matches={data.matches}
                  active={active}
                  hover={hover}
                  onActivate={activate}
                  onHover={setHover}
                />
              </div>
            </>
          )}
        </div>
        {chatOpen && <ChatPanel a={a} b={b} onClose={() => setChatOpen(false)} />}
      </div>
    </div>
  )
}
