import { polygonHull } from 'd3-polygon'
import { quadtree, type Quadtree } from 'd3-quadtree'
import { select } from 'd3-selection'
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClusterInfo, MapPoint } from '@/lib/api'
import { BANDS, bandOf } from '@/lib/pairs'
import { clusterColor, docTitle } from '@/lib/utils'

interface Props {
  points: MapPoint[]
  clusters: ClusterInfo[]
  selectedCluster: number | null
  highlight: Set<string> | null
  /** Near-duplicate pairs drawn as lines between their documents. */
  links?: { a: string; b: string; score: number }[]
  /** Screen space covered by overlays; the fitted view avoids it. */
  insets?: { top?: number; right?: number; bottom?: number; left?: number }
  onSelectDoc: (id: string) => void
  onSelectCluster: (id: number | null) => void
}

// World-space padding around the data: hull expansion plus a little breathing room.
const FIT_PAD = 1.1
// Extra screen space above the data for cluster labels.
const LABEL_SPACE = 26

function expandHull(hull: [number, number][], pad: number): [number, number][] {
  const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length
  const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length
  return hull.map(([x, y]) => {
    const dx = x - cx
    const dy = y - cy
    const d = Math.hypot(dx, dy) || 1
    return [x + (dx / d) * pad, y + (dy / d) * pad]
  })
}

/** Smooth closed curve through hull points (Catmull-Rom -> Bezier). */
function drawSmoothHull(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  const n = pts.length
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % n]
    const p3 = pts[(i + 2) % n]
    if (i === 0) ctx.moveTo(p1[0], p1[1])
    ctx.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) / 6,
      p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6,
      p2[1] - (p3[1] - p1[1]) / 6,
      p2[0],
      p2[1],
    )
  }
  ctx.closePath()
}

export function ClusterMap({ points, clusters, selectedCluster, highlight, links, insets, onSelectDoc, onSelectCluster }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const zoomRef = useRef<ZoomBehavior<HTMLCanvasElement, unknown> | null>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity)
  const [hover, setHover] = useState<{ p: MapPoint; sx: number; sy: number } | null>(null)

  const bounds = useMemo(() => {
    if (points.length === 0) return { minX: -1, maxX: 1, minY: -1, maxY: 1 }
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const p of points) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
    return { minX: minX - FIT_PAD, maxX: maxX + FIT_PAD, minY: minY - FIT_PAD, maxY: maxY + FIT_PAD }
  }, [points])

  const inTop = (insets?.top ?? 0) + LABEL_SPACE
  const inRight = insets?.right ?? 0
  const inBottom = insets?.bottom ?? 0
  const inLeft = insets?.left ?? 0

  // Fit the visible data into the canvas area not covered by overlays (before user zoom).
  const base = useMemo(() => {
    const availW = Math.max(120, size.w - inLeft - inRight)
    const availH = Math.max(120, size.h - inTop - inBottom)
    const spanX = Math.max(2, bounds.maxX - bounds.minX)
    const spanY = Math.max(2, bounds.maxY - bounds.minY)
    const s = Math.min(availW / spanX, availH / spanY)
    const cx = (bounds.minX + bounds.maxX) / 2
    const cy = (bounds.minY + bounds.maxY) / 2
    const scx = inLeft + availW / 2
    const scy = inTop + availH / 2
    return { s, ox: scx - cx * s, oy: scy + cy * s }
  }, [size, bounds, inTop, inRight, inBottom, inLeft])

  // Re-centre (drop user pan/zoom) whenever the fitted frame changes.
  const fitKey = `${base.s.toFixed(3)}|${base.ox.toFixed(1)}|${base.oy.toFixed(1)}`
  useEffect(() => {
    if (canvasRef.current && zoomRef.current) select(canvasRef.current).call(zoomRef.current.transform, zoomIdentity)
  }, [fitKey])

  const toScreen = useCallback(
    (x: number, y: number): [number, number] => transform.apply([base.ox + x * base.s, base.oy - y * base.s]),
    [transform, base],
  )

  const tree: Quadtree<MapPoint> = useMemo(
    () => quadtree<MapPoint>().x((p) => p.x).y((p) => p.y).addAll(points),
    [points],
  )

  const hulls = useMemo(() => {
    const byCluster = new Map<number, [number, number][]>()
    for (const p of points) {
      if (p.clusterId < 0) continue
      const arr = byCluster.get(p.clusterId) ?? []
      arr.push([p.x, p.y])
      byCluster.set(p.clusterId, arr)
    }
    const out = new Map<number, [number, number][]>()
    for (const [id, pts] of byCluster) {
      let hull = pts.length >= 3 ? polygonHull(pts) : null
      if (!hull) {
        const [cx, cy] = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0])
        const r = 0.35
        hull = Array.from({ length: 8 }, (_, i) => [cx + r * Math.cos((i * Math.PI) / 4), cy + r * Math.sin((i * Math.PI) / 4)])
      }
      out.set(id, expandHull(hull, 0.45))
    }
    return out
  }, [points])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({ w: Math.max(200, width), h: Math.max(200, height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const z = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.5, 40])
      .on('zoom', (e: { transform: ZoomTransform }) => setTransform(e.transform))
    zoomRef.current = z
    select(canvas).call(z).on('dblclick.zoom', null)
    return () => {
      select(canvas).on('.zoom', null)
    }
  }, [])

  // draw
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = size.w * dpr
    canvas.height = size.h * dpr
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)

    const dimmed = (p: MapPoint) =>
      (selectedCluster !== null && p.clusterId !== selectedCluster) || (highlight !== null && !highlight.has(p.id))

    for (const [id, hull] of hulls) {
      const color = clusterColor(id)
      const active = selectedCluster === null || selectedCluster === id
      drawSmoothHull(ctx, hull.map(([x, y]) => toScreen(x, y)))
      ctx.fillStyle = color + (active ? '1f' : '0a')
      ctx.fill()
      ctx.strokeStyle = color + (active ? '66' : '22')
      ctx.lineWidth = 1.2
      ctx.stroke()
    }

    const r = Math.max(2.5, Math.min(7, 3 * Math.sqrt(transform.k)))
    if (links?.length) {
      const byId = new Map(points.map((p) => [p.id, p]))
      ctx.lineCap = 'round'
      for (const l of [...links].sort((x, y) => x.score - y.score)) {
        const pa = byId.get(l.a)
        const pb = byId.get(l.b)
        if (!pa || !pb) continue
        const faded = dimmed(pa) && dimmed(pb)
        const [ax, ay] = toScreen(pa.x, pa.y)
        const [bx, by] = toScreen(pb.x, pb.y)
        ctx.beginPath()
        ctx.moveTo(ax, ay)
        ctx.lineTo(bx, by)
        ctx.strokeStyle = BANDS[bandOf(l.score)].color + (faded ? '30' : 'cc')
        ctx.lineWidth = 1 + Math.max(0, (l.score - 0.85) / 0.15) * 3
        ctx.stroke()
      }
    }
    for (const p of points) {
      if (!dimmed(p)) continue
      const [sx, sy] = toScreen(p.x, p.y)
      ctx.beginPath()
      ctx.arc(sx, sy, r * 0.8, 0, Math.PI * 2)
      ctx.fillStyle = '#2a2f3d'
      ctx.fill()
    }
    for (const p of points) {
      if (dimmed(p)) continue
      const [sx, sy] = toScreen(p.x, p.y)
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      ctx.fillStyle = clusterColor(p.clusterId)
      ctx.shadowColor = clusterColor(p.clusterId)
      ctx.shadowBlur = p.clusterId >= 0 ? 8 : 0
      ctx.fill()
      ctx.shadowBlur = 0
      if (highlight?.has(p.id)) {
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }
    if (hover) {
      const [sx, sy] = toScreen(hover.p.x, hover.p.y)
      ctx.beginPath()
      ctx.arc(sx, sy, r + 4, 0, Math.PI * 2)
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2
      ctx.stroke()
    }

    ctx.font = '600 12px Inter, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const c of clusters) {
      const hull = hulls.get(c.id)
      if (!hull) continue
      const top = hull.reduce((m, p) => (p[1] > m[1] ? p : m), hull[0])
      const [sx] = toScreen(c.cx, c.cy)
      const [, sy] = toScreen(top[0], top[1])
      const text = c.label.length > 38 ? c.label.slice(0, 36) + '…' : c.label
      const w = ctx.measureText(text).width + 16
      const active = selectedCluster === null || selectedCluster === c.id
      ctx.globalAlpha = active ? 1 : 0.35
      ctx.fillStyle = 'rgba(18,21,28,0.88)'
      ctx.strokeStyle = clusterColor(c.id) + '88'
      ctx.beginPath()
      ctx.roundRect(sx - w / 2, sy - 22, w, 20, 10)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = '#e7eaf0'
      ctx.fillText(text, sx, sy - 12)
      ctx.globalAlpha = 1
    }
  }, [points, clusters, hulls, size, transform, toScreen, selectedCluster, highlight, hover, links])

  const pick = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const [bx, by] = transform.invert([mx, my])
    const wx = (bx - base.ox) / base.s
    const wy = -(by - base.oy) / base.s
    const radius = 10 / (base.s * transform.k)
    const p = tree.find(wx, wy, radius)
    return { p, mx, my }
  }

  const clusterAt = (wx: number, wy: number): number | null => {
    for (const [id, hull] of hulls) {
      let inside = false
      for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
        const [xi, yi] = hull[i]
        const [xj, yj] = hull[j]
        if (yi > wy !== yj > wy && wx < ((xj - xi) * (wy - yi)) / (yj - yi) + xi) inside = !inside
      }
      if (inside) return id
    }
    return null
  }

  const resetZoom = () => {
    if (canvasRef.current && zoomRef.current) select(canvasRef.current).call(zoomRef.current.transform, zoomIdentity)
  }

  return (
    <div ref={wrapRef} className="bg-grid relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, cursor: hover ? 'pointer' : 'grab' }}
        onMouseMove={(e) => {
          const { p, mx, my } = pick(e)
          setHover(p ? { p, sx: mx, sy: my } : null)
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const { p } = pick(e)
          if (p) return onSelectDoc(p.id)
          const rect = canvasRef.current!.getBoundingClientRect()
          const [bx, by] = transform.invert([e.clientX - rect.left, e.clientY - rect.top])
          const c = clusterAt((bx - base.ox) / base.s, -(by - base.oy) / base.s)
          onSelectCluster(c === selectedCluster ? null : c)
        }}
      />
      {hover && (
        <div
          className="pointer-events-none absolute z-10 max-w-xs rounded-lg border border-border bg-panel-2/95 px-3 py-2 text-xs shadow-xl backdrop-blur"
          style={{ left: Math.min(hover.sx + 14, size.w - 260), top: hover.sy + 14 }}
        >
          <div className="font-medium text-fg">{docTitle(hover.p)}</div>
          <div className="mt-0.5 text-muted">{hover.p.name}</div>
          <div className="mt-1 flex items-center gap-1.5 text-muted">
            <span className="size-2 rounded-full" style={{ background: clusterColor(hover.p.clusterId) }} />
            {hover.p.clusterId >= 0 ? clusters.find((c) => c.id === hover.p.clusterId)?.label : 'Unclustered'}
          </div>
        </div>
      )}
      <button
        onClick={resetZoom}
        className="absolute bottom-3 left-3 rounded-md border border-border bg-panel-2/90 px-2.5 py-1 text-xs text-muted hover:text-fg"
      >
        Reset view
      </button>
    </div>
  )
}
