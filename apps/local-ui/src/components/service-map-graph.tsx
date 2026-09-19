// The service map's drawing — hand-rolled SVG over `lib/service-map-layout`.
//
// The web app's map is React Flow + ELK + a web worker. None of that is carried
// into local mode: this is one `<svg>` at natural scale (1 unit = 1 px), which
// is also what lets the tooltip be a plain absolutely-positioned div at a
// node's `x`/`y` instead of a projection through a pan/zoom transform.
//
// Everything a tooltip says is also in the edge table beside the graph, and
// every node is a real focusable button, so the map is never the only way to
// reach a number.

import { useMemo, useState } from "react"
import { getServiceColor } from "@maple/ui/lib/colors"
import { formatErrorRate, formatLatency, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { ServiceMapEdge, ServiceMapNode } from "../hooks/use-local-service-map"
import { layoutServiceMap, type LayoutNode } from "../lib/service-map-layout"

const NODE_WIDTH = 168
const NODE_HEIGHT = 46
const PADDING = 28

/** Above this share of failed calls an edge is drawn as a problem, not a link. */
export const EDGE_ERROR_THRESHOLD = 0.05

const MAX_LABEL_CHARS = 20

/** Above this much headroom the tooltip sits above its subject; below it, under. */
const TOOLTIP_FLIP_Y = 120

interface ServiceMapGraphProps {
	nodes: readonly ServiceMapNode[]
	edges: readonly ServiceMapEdge[]
	maxCallCount: number
	onSelectService: (serviceName: string) => void
}

type Hovered =
	| { readonly kind: "node"; readonly node: ServiceMapNode; readonly x: number; readonly y: number }
	| { readonly kind: "edge"; readonly edge: ServiceMapEdge; readonly x: number; readonly y: number }

export function ServiceMapGraph({ nodes, edges, maxCallCount, onSelectService }: ServiceMapGraphProps) {
	const [hovered, setHovered] = useState<Hovered | null>(null)

	const layout = useMemo(
		() =>
			layoutServiceMap(
				nodes.map((node) => node.id),
				edges,
				{ nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT },
			),
		[nodes, edges],
	)
	// Identity, not value: `backEdges` hands back the very objects it was given.
	const reversed = useMemo(() => new Set(layout.backEdges), [layout])

	const byId = new Map(nodes.map((node) => [node.id, node]))

	return (
		<div className="relative min-w-0 overflow-auto">
			<svg
				role="img"
				aria-label={`Service dependency graph: ${nodes.length} nodes, ${edges.length} edges`}
				width={layout.width + PADDING * 2}
				height={layout.height + PADDING * 2}
				className="block"
			>
				<defs>
					<Arrowhead id="service-map-arrow" className="fill-muted-foreground" />
					<Arrowhead id="service-map-arrow-error" className="fill-destructive" />
				</defs>
				<g transform={`translate(${PADDING}, ${PADDING})`}>
					{edges.map((edge) => {
						const from = layout.byId.get(edge.source)
						const to = layout.byId.get(edge.target)
						if (!from || !to) return null
						const failing = edge.errorRate > EDGE_ERROR_THRESHOLD
						const midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
						return (
							<path
								key={edge.id}
								d={edgePath(from, to)}
								fill="none"
								strokeLinecap="round"
								strokeWidth={strokeWidth(edge.callCount, maxCallCount)}
								strokeDasharray={reversed.has(edge) ? "5 4" : undefined}
								markerEnd={`url(#service-map-arrow${failing ? "-error" : ""})`}
								className={cn(
									"transition-opacity",
									failing ? "stroke-destructive" : "stroke-muted-foreground/50",
									hovered?.kind === "edge" && hovered.edge.id !== edge.id && "opacity-30",
								)}
								onMouseEnter={() =>
									setHovered({ kind: "edge", edge, x: midpoint.x, y: midpoint.y })
								}
								onMouseLeave={() => setHovered(null)}
							>
								<title>{`${labelFor(byId, edge.source)} → ${labelFor(byId, edge.target)}: ${formatNumber(edge.callCount)} calls`}</title>
							</path>
						)
					})}

					{nodes.map((node) => {
						const placed = layout.byId.get(node.id)
						if (!placed) return null
						return (
							<GraphNode
								key={node.id}
								node={node}
								placed={placed}
								onHover={(on) =>
									setHovered(on ? { kind: "node", node, x: placed.x, y: placed.y } : null)
								}
								onSelect={
									node.serviceName ? () => onSelectService(node.serviceName!) : undefined
								}
							/>
						)
					})}
				</g>
			</svg>

			{hovered ? (
				<div
					// Above the hovered thing and clear of the pointer, so moving onto
					// the card cannot flicker the hover it is describing — except in
					// the top row, where above is off the canvas and it goes below.
					className={cn(
						"pointer-events-none absolute z-10 w-56 -translate-x-1/2 rounded-md border bg-popover p-2 text-popover-foreground shadow-md",
						hovered.y < TOOLTIP_FLIP_Y ? "translate-y-[18px]" : "-translate-y-[calc(100%+14px)]",
					)}
					style={{ left: hovered.x + PADDING, top: hovered.y + PADDING }}
				>
					{hovered.kind === "node" ? (
						<NodeTooltip node={hovered.node} />
					) : (
						<EdgeTooltip edge={hovered.edge} nodes={byId} />
					)}
				</div>
			) : null}
		</div>
	)
}

function GraphNode({
	node,
	placed,
	onHover,
	onSelect,
}: {
	node: ServiceMapNode
	placed: LayoutNode
	onHover: (on: boolean) => void
	onSelect?: () => void
}) {
	const left = placed.x - NODE_WIDTH / 2
	const top = placed.y - NODE_HEIGHT / 2
	const failing = node.errorRate > EDGE_ERROR_THRESHOLD
	return (
		<g
			role={onSelect ? "button" : "img"}
			aria-label={`${node.label}: ${formatNumber(node.spanCount)} ${node.kind === "database" ? "calls" : "spans"}, ${formatErrorRate(node.errorRate)} errors`}
			tabIndex={onSelect ? 0 : undefined}
			className={cn("group outline-none", onSelect && "cursor-pointer")}
			onMouseEnter={() => onHover(true)}
			onMouseLeave={() => onHover(false)}
			onFocus={() => onHover(true)}
			onBlur={() => onHover(false)}
			onClick={onSelect}
			onKeyDown={(event) => {
				if (onSelect && (event.key === "Enter" || event.key === " ")) {
					event.preventDefault()
					onSelect()
				}
			}}
		>
			<rect
				x={left}
				y={top}
				width={NODE_WIDTH}
				height={NODE_HEIGHT}
				rx={node.kind === "database" ? 22 : 10}
				strokeWidth={1}
				strokeDasharray={node.kind === "database" ? "4 3" : undefined}
				className={cn(
					"fill-card transition-colors",
					failing ? "stroke-destructive" : "stroke-border",
					"group-focus-visible:stroke-ring",
				)}
			/>
			{node.kind === "database" ? (
				<DatabaseGlyph x={left + 14} y={placed.y} />
			) : (
				<circle cx={left + 17} cy={placed.y} r={4} fill={getServiceColor(node.label)} />
			)}
			<text
				x={left + 30}
				y={placed.y}
				dominantBaseline="central"
				className="fill-foreground text-[12px] font-medium"
			>
				{truncate(node.label)}
			</text>
			<title>{node.label}</title>
		</g>
	)
}

/** A two-ellipse cylinder — enough to read as "not a service" at 14 px. */
function DatabaseGlyph({ x, y }: { x: number; y: number }) {
	return (
		<g className="fill-none stroke-muted-foreground" strokeWidth={1.2}>
			<ellipse cx={x} cy={y - 4} rx={5} ry={2} />
			<path
				d={`M ${x - 5} ${y - 4} L ${x - 5} ${y + 4} A 5 2 0 0 0 ${x + 5} ${y + 4} L ${x + 5} ${y - 4}`}
			/>
		</g>
	)
}

function Arrowhead({ id, className }: { id: string; className: string }) {
	return (
		<marker
			id={id}
			viewBox="0 0 10 10"
			refX={9}
			refY={5}
			markerWidth={6}
			markerHeight={6}
			orient="auto-start-reverse"
		>
			<path d="M 0 0 L 10 5 L 0 10 z" className={className} />
		</marker>
	)
}

function NodeTooltip({ node }: { node: ServiceMapNode }) {
	return (
		<>
			<p className="truncate text-xs font-medium">{node.label}</p>
			<p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
				{node.kind === "database" ? node.dbSystem || "database" : "service"}
			</p>
			<TooltipRow
				label={node.kind === "database" ? "Calls" : "Spans"}
				value={formatNumber(node.spanCount)}
			/>
			<TooltipRow
				label="Error rate"
				value={formatErrorRate(node.errorRate)}
				danger={node.errorRate > EDGE_ERROR_THRESHOLD}
			/>
			<TooltipRow
				label={node.kind === "database" ? "p95 (slowest edge)" : "p95"}
				value={formatLatency(node.p95Ms)}
			/>
			{node.serviceName ? (
				<p className="mt-1 text-[10px] text-muted-foreground">Click to open the service</p>
			) : null}
		</>
	)
}

function EdgeTooltip({ edge, nodes }: { edge: ServiceMapEdge; nodes: ReadonlyMap<string, ServiceMapNode> }) {
	return (
		<>
			<p className="truncate text-xs font-medium">
				{labelFor(nodes, edge.source)} → {labelFor(nodes, edge.target)}
			</p>
			<TooltipRow label="Calls" value={formatNumber(edge.callCount)} />
			<TooltipRow
				label="Errors"
				value={`${formatNumber(edge.errorCount)} (${formatErrorRate(edge.errorRate)})`}
				danger={edge.errorRate > EDGE_ERROR_THRESHOLD}
			/>
			<TooltipRow label="Avg" value={formatLatency(edge.avgMs)} />
			<TooltipRow label="p95" value={formatLatency(edge.p95Ms)} />
		</>
	)
}

function TooltipRow({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
	return (
		<p className="flex items-baseline justify-between gap-3 text-[11px]">
			<span className="text-muted-foreground">{label}</span>
			<span className={cn("tabular-nums", danger && "text-destructive")}>{value}</span>
		</p>
	)
}

function labelFor(nodes: ReadonlyMap<string, ServiceMapNode>, id: string): string {
	return nodes.get(id)?.label ?? id
}

function truncate(label: string): string {
	return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label
}

/**
 * Call volume → stroke width, on a square root so the busiest edge in a local
 * store (often orders of magnitude above the rest) does not reduce every other
 * edge to a hairline.
 */
function strokeWidth(callCount: number, maxCallCount: number): number {
	if (maxCallCount <= 0) return 1.5
	return 1.25 + 4 * Math.sqrt(Math.min(1, callCount / maxCallCount))
}

/**
 * A cubic between two node borders. Back edges — the ones the layout reversed
 * to break a cycle — leave the source's LEFT side and enter the target's right,
 * so the arrow still reads as "calls" while pointing the other way.
 */
function edgePath(from: LayoutNode, to: LayoutNode): string {
	const backwards = to.x <= from.x
	const startX = from.x + (backwards ? -NODE_WIDTH / 2 : NODE_WIDTH / 2)
	const endX = to.x + (backwards ? NODE_WIDTH / 2 : -NODE_WIDTH / 2)
	const bend = backwards ? -Math.max(50, Math.abs(endX - startX) / 2) : Math.max(40, (endX - startX) / 2)
	return `M ${startX} ${from.y} C ${startX + bend} ${from.y}, ${endX - bend} ${to.y}, ${endX} ${to.y}`
}
