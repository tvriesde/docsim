import { useQuery } from '@tanstack/react-query'
import { Copy, FileStack, LayoutDashboard, LogOut, Network, Pin, PinOff, Upload } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Tooltip } from '@/components/ui'
import { api } from '@/lib/api'
import { logout } from '@/lib/auth'
import { config } from '@/lib/config'
import { cn } from '@/lib/utils'
import { ComparePage } from '@/pages/Compare'
import { DashboardPage } from '@/pages/Dashboard'
import { DocumentGraphPage } from '@/pages/DocumentGraph'
import { DocumentsPage } from '@/pages/Documents'
import { NearDuplicatesPage } from '@/pages/NearDuplicates'
import { UploadPage } from '@/pages/Upload'

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/documents', label: 'Documents', icon: FileStack, end: false },
  { to: '/duplicates', label: 'Near-duplicates', icon: Copy, end: false },
  { to: '/upload', label: 'Upload', icon: Upload, end: false },
]

const PIN_KEY = 'docsim.sidebarPinned'

/** Icon rail that expands over the content on hover; can be pinned open. */
function Sidebar() {
  const [pinned, setPinned] = useState(() => localStorage.getItem(PIN_KEY) === '1')
  const [hover, setHover] = useState(false)
  const open = pinned || hover
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Infinity })
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 5_000 })
  const initials = (me.data?.name ?? '?')
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
  const togglePin = () => {
    localStorage.setItem(PIN_KEY, pinned ? '0' : '1')
    setPinned(!pinned)
  }
  const queue = stats.data?.queue ?? 0

  return (
    <div className={cn('relative z-40 shrink-0 transition-[width] duration-200', pinned ? 'w-60' : 'w-14')}>
      <aside
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className={cn(
          'absolute inset-y-0 left-0 flex flex-col overflow-hidden border-r border-border bg-panel transition-[width,box-shadow] duration-200',
          open ? 'w-60' : 'w-14',
          open && !pinned && 'shadow-2xl shadow-black/60',
        )}
      >
        <div className="flex items-center gap-2.5 px-3 py-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent-2 text-white">
            <Network className="size-4" />
          </div>
          <div className={cn('min-w-0 flex-1 transition-opacity', open ? 'opacity-100' : 'opacity-0')}>
            <div className="text-sm font-semibold leading-none">DocSim</div>
            <div className="mt-1 text-[11px] text-muted">Document similarity</div>
          </div>
          {open && (
            <Tooltip content={pinned ? 'Unpin sidebar' : 'Keep sidebar open'}>
              <button className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg" onClick={togglePin}>
                {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
              </button>
            </Tooltip>
          )}
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={() => setHover(false)}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive ? 'bg-accent/15 text-fg' : 'text-muted hover:bg-panel-2 hover:text-fg',
                )
              }
            >
              <Icon className="size-4 shrink-0" />
              <span className={cn('transition-opacity', open ? 'opacity-100' : 'opacity-0')}>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-3 p-2">
          {queue > 0 && (
            <div className="flex items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-panel-2 px-3 py-2 text-xs text-muted">
              <span className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-accent-2" />
              {open ? `Processing ${queue} document${queue === 1 ? '' : 's'}` : queue}
            </div>
          )}
          <div className="flex items-center gap-2.5 rounded-lg px-1 py-1">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-panel-2 text-xs font-semibold text-muted">
              {initials}
            </div>
            <div className={cn('min-w-0 flex-1 transition-opacity', open ? 'opacity-100' : 'opacity-0')}>
              <div className="truncate text-xs font-medium">{me.data?.name ?? '…'}</div>
              <div className="truncate text-[11px] text-muted">{me.data?.username ?? (config().authEnabled ? '' : 'local mode')}</div>
            </div>
            {open && config().authEnabled && (
              <Tooltip content="Sign out">
                <button className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg" onClick={() => void logout()}>
                  <LogOut className="size-4" />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}

export default function App() {
  const fullScreen = useLocation().pathname.startsWith('/compare/')
  return (
    <div className="flex h-full">
      {!fullScreen && <Sidebar />}
      <main className="min-w-0 flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/documents/:id" element={<DocumentGraphPage />} />
          <Route path="/duplicates" element={<NearDuplicatesPage />} />
          <Route path="/compare/:a/:b" element={<ComparePage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
