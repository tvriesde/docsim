import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { FileText } from 'lucide-react'
import { useEffect } from 'react'
import type { SimilarResult } from '@/lib/api'
import { cn, clusterColor, docTitle, scoreColor } from '@/lib/utils'

type DocNodeData = { title: string; name: string; score?: number; clusterId?: number | null; center?: boolean }
type DocNode = Node<DocNodeData, 'doc'>

function SideHandles() {
  return (
    <>
      {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
        <span key={side}>
          <Handle id={`s-${side}`} type="source" position={side as Position} className="!opacity-0" isConnectable={false} />
          <Handle id={`t-${side}`} type="target" position={side as Position} className="!opacity-0" isConnectable={false} />
        </span>
      ))}
    </>
  )
}

function DocNodeView({ data, selected }: NodeProps<DocNode>) {
  return (
    <div
      className={cn(
        'w-52 rounded-xl border bg-panel px-3 py-2.5 shadow-lg transition-shadow',
        data.center ? 'border-accent shadow-[0_0_0_4px_rgb(124_92_255/0.18)]' : 'border-border hover:border-muted',
        selected && 'ring-2 ring-accent-2/60',
      )}
    >
      <SideHandles />
      <div className="flex items-start gap-2">
        <div
          className="mt-0.5 rounded-md p-1"
          style={{ background: clusterColor(data.clusterId) + '26', color: clusterColor(data.clusterId) }}
        >
          <FileText className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-xs font-medium leading-snug text-fg">{data.title}</div>
          <div className="mt-0.5 truncate text-[10px] text-muted">{data.name}</div>
        </div>
      </div>
      {data.score !== undefined && (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-border">
            <div className="h-full rounded-full" style={{ width: `${Math.max(0, data.score) * 100}%`, background: scoreColor(data.score) }} />
          </div>
          <span className="font-mono text-[10px]" style={{ color: scoreColor(data.score) }}>
            {data.score.toFixed(3)}
          </span>
        </div>
      )}
      {data.center && <div className="mt-1.5 text-[10px] font-medium uppercase tracking-wider text-accent">Selected document</div>}
    </div>
  )
}

const nodeTypes = { doc: DocNodeView }

const NODE_W = 208
const NODE_H = 80

function side(dx: number, dy: number): 'top' | 'right' | 'bottom' | 'left' {
  if (Math.abs(dx) / NODE_W > Math.abs(dy) / NODE_H) return dx > 0 ? 'right' : 'left'
  return dy > 0 ? 'bottom' : 'top'
}

/** Radial layout: the center doc in the middle, neighbors on a ring; more similar = closer. */
function layout(result: SimilarResult): { nodes: DocNode[]; edges: Edge[] } {
  const n = result.neighbors.length
  const scores = result.neighbors.map((d) => d.score)
  const max = Math.max(...scores, 0)
  const min = Math.min(...scores, max)
  const minRadius = Math.max(260, (n * 230) / (2 * Math.PI) * 0.75)
  const nodes: DocNode[] = [
    {
      id: result.center.id,
      type: 'doc',
      position: { x: -NODE_W / 2, y: -NODE_H / 2 },
      zIndex: 10,
      data: { title: docTitle(result.center), name: result.center.name, clusterId: result.center.clusterId, center: true },
    },
  ]
  result.neighbors.forEach((d, i) => {
    const t = max > min ? (max - d.score) / (max - min) : 0
    const r = minRadius + t * 200 + (i % 2) * 40
    const angle = (2 * Math.PI * i) / Math.max(n, 1) - Math.PI / 2
    nodes.push({
      id: d.id,
      type: 'doc',
      position: { x: Math.cos(angle) * r - NODE_W / 2, y: Math.sin(angle) * r - NODE_H / 2 },
      zIndex: 10,
      data: { title: docTitle(d), name: d.name, score: d.score, clusterId: d.clusterId },
    })
  })
  const pos = new Map(nodes.map((nd) => [nd.id, nd.position]))
  const edges: Edge[] = result.edges.map((e) => {
    const primary = e.kind === 'primary'
    const color = scoreColor(e.score)
    const a = pos.get(e.source)!
    const b = pos.get(e.target)!
    return {
      id: `${e.source}-${e.target}`,
      source: e.source,
      target: e.target,
      sourceHandle: `s-${side(b.x - a.x, b.y - a.y)}`,
      targetHandle: `t-${side(a.x - b.x, a.y - b.y)}`,
      type: 'straight',
      label: primary ? e.score.toFixed(2) : undefined,
      labelStyle: { fill: color, fontSize: 10, fontFamily: 'ui-monospace, monospace' },
      labelBgStyle: { fill: '#12151c', fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      style: {
        stroke: color,
        strokeWidth: primary ? 1.5 + Math.max(0, e.score) * 2.5 : 1,
        strokeOpacity: primary ? 0.9 : 0.28,
        strokeDasharray: primary ? undefined : '4 4',
      },
      zIndex: primary ? 1 : 0,
    }
  })
  return { nodes, edges }
}

export function SimilarityGraph({
  result,
  onOpen,
  onSelect,
}: {
  result: SimilarResult
  onOpen: (id: string) => void
  onSelect: (id: string | null) => void
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<DocNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  useEffect(() => {
    const l = layout(result)
    setNodes(l.nodes)
    setEdges(l.edges)
  }, [result, setNodes, setEdges])

  return (
    <ReactFlow
      key={result.center.id}
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      colorMode="dark"
      fitView
      fitViewOptions={{ padding: 0.15 }}
      minZoom={0.2}
      maxZoom={2}
      nodesConnectable={false}
      onNodeDoubleClick={(_, node) => {
        if (node.id !== result.center.id) onOpen(node.id)
      }}
      onNodeClick={(_, node) => onSelect(node.id)}
      onPaneClick={() => onSelect(null)}
      proOptions={{ hideAttribution: true }}
      style={{ background: 'transparent' }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#2a2f3d" />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  )
}

export function ScoreLegend({ lo = 0.3, hi = 0.95 }: { lo?: number; hi?: number }) {
  const stops = Array.from({ length: 11 }, (_, i) => scoreColor(lo + ((hi - lo) * i) / 10, lo, hi))
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted">
      <span>{lo.toFixed(2)}</span>
      <div className="h-2 w-40 rounded-full" style={{ background: `linear-gradient(to right, ${stops.join(',')})` }} />
      <span>{hi.toFixed(2)}+</span>
    </div>
  )
}
