import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

const PALETTE = [
  '#7c5cff', '#22d3ee', '#f472b6', '#34d399', '#fbbf24', '#60a5fa', '#fb7185', '#a3e635',
  '#c084fc', '#2dd4bf', '#f97316', '#818cf8', '#e879f9', '#4ade80', '#facc15', '#38bdf8',
]

export function clusterColor(id: number | null | undefined): string {
  if (id === null || id === undefined || id < 0) return '#4b5263'
  return PALETTE[id % PALETTE.length]
}

/** Maps a similarity score in [lo, hi] onto red -> amber -> green. */
export function scoreColor(score: number, lo = 0.3, hi = 0.95): string {
  const t = Math.max(0, Math.min(1, (score - lo) / (hi - lo)))
  const hue = t * 140
  return `hsl(${hue.toFixed(0)} 85% 55%)`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return '—'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}

export function docTitle(d: { title?: string; name: string }): string {
  return d.title?.trim() || d.name
}
