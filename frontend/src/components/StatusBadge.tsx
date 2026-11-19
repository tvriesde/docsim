import type { DocStatus } from '@/lib/api'
import { Badge, Spinner } from './ui'

const TONES: Record<DocStatus, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  queued: 'neutral',
  extracting: 'info',
  cleaning: 'info',
  embedding: 'info',
  ready: 'success',
  failed: 'danger',
}

export function StatusBadge({ status }: { status: DocStatus }) {
  const active = status !== 'ready' && status !== 'failed' && status !== 'queued'
  return (
    <Badge tone={TONES[status]}>
      {active && <Spinner className="size-2.5 border" />}
      {status}
    </Badge>
  )
}
