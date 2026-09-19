// The service map's drawing — hand-rolled SVG edges under HTML node cards.
//
// The web app's map is React Flow + ELK + a web worker. None of that is carried
// into local mode: the layout is `lib/service-map-layout` and the drawing is
// one `<svg>` at natural scale (1 unit = 1 px) with the cards positioned over
// it in HTML at the same coordinates.
//
// **Cards are HTML, edges are SVG**, which is not a compromise between two ways
// of doing one thing. A card is a name, a status tint and three stat columns —
// flexbox, truncation, tabular figures, a real `<button>` with a real focus
// ring — all of which SVG makes hard and none of which it makes better. Edges
// are paths with markers and motion, which HTML has no answer for at all.
// Sharing one coordinate system costs nothing because the scale is 1.
//
// Everything a card or a tooltip says is also in the edge table beside the
// graph, so the map is never the only way to reach a number.

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { getServiceColor } from "@maple/ui/lib/colors"
import { formatErrorRate, formatLatency, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { ServiceMapEdge, ServiceMapNode } from "../hooks/use-local-service-map"
import { elbowPath, layoutServiceMap, portOffsets, type LayoutNode } from "../lib/service-map-layout"
import { formatRate, formatRateLabel, perSecond } from "../lib/service-map-stats"

const NODE_WIDTH = 212
const NODE_HEIGHT = 78
const PADDING = 32

/** Above this share of failed calls an edge is drawn as a problem, not a link. */
export const EDGE_ERROR_THRESHOLD = 0.05

/** Above this much headroom the tooltip sits above its subject; below it, under. */
const TOOLTIP_FLIP_Y = 140

/** How many of the busiest edges carry a rate label. More than this is noise. */
const LABELLED_EDGE_COUNT = 3

/** Flow dots, slowest to fastest, and the most that travel one edge at once. */
const FLOW_SECONDS_SLOW = 5
const FLOW_SECONDS_FAST = 2
const FLOW_MAX_DOTS = 3

interface ServiceMapGraphProps {
	nodes: readonly ServiceMapNode[]
	edges: readonly ServiceMapEdge[]
	maxCallCount: number
	/** The window's nominal length — the denominator for every rate on screen. */
	windowSeconds: number
	onSelectService: (serviceName: string) => void
}

type Hovered =
	| { readonly kind: "node"; readonly node: ServiceMapNode; readonly x: number; readonly y: number }
	| { readonly kind: "edge"; readonly edge: ServiceMapEdge; readonly x: number; readonly y: number }

interface RoutedEdge {
	readonly edge: ServiceMapEdge
	readonly d: string
	readonly mid: { readonly x: number; readonly y: number }
	readonly color: string
	readonly failing: boolean
	readonly width: number
	readonly reversed: boolean
}

export function ServiceMapGraph({
	nodes,
	edges,
	maxCallCount,
	windowSeconds,
	onSelectService,
}: ServiceMapGraphProps) {
	const [hovered, setHovered] = useState<Hovered | null>(null)
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const reducedMotion = usePrefersReducedMotion()

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

	const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])

	const routed = useMemo(
		() => routeEdges(edges, layout, byId, reversed, maxCallCount),
		[edges, layout, byId, reversed, maxCallCount],
	)

	// One marker per colour in use: a marker takes its own fill, not the stroke
	// of the path that references it, so a shared arrowhead would be grey on
	// every coloured edge.
	const markers = useMemo(() => {
		const ids = new Map<string, string>()
		for (const route of routed) {
			if (!ids.has(route.color)) ids.set(route.color, `service-map-arrow-${ids.size}`)
		}
		return ids
	}, [routed])

	const labelled = useMemo(() => {
		const busiest = [...routed]
			.sort((a, b) => b.edge.callCount - a.edge.callCount || a.edge.id.localeCompare(b.edge.id))
			.slice(0, LABELLED_EDGE_COUNT)
		return new Set(busiest.filter((route) => route.edge.callCount > 0).map((route) => route.edge.id))
	}, [routed])

	// A node is selected: everything not touching it steps back. Nothing is
	// hidden — a dimmed edge is still hoverable and still in the table below.
	const isDimmed = (edge: ServiceMapEdge) => {
		if (hovered?.kind === "edge" && hovered.edge.id !== edge.id) return true
		if (selectedId === null) return false
		return edge.source !== selectedId && edge.target !== selectedId
	}

	const selected = selectedId === null ? null : byId.get(selectedId)
	const selectedPlaced = selectedId === null ? null : layout.byId.get(selectedId)

	return (
		<div className="relative min-w-0 overflow-auto">
			<div
				className="relative"
				// Clicking the canvas rather than a card clears the selection — the
				// way back out that needs no target. The edge layer above is
				// `pointer-events-none` apart from its hit paths, so a click on
				// empty canvas lands here.
				onClick={(event) => {
					if (event.target === event.currentTarget) setSelectedId(null)
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape") setSelectedId(null)
				}}
				style={{
					width: layout.width + PADDING * 2,
					height: layout.height + PADDING * 2,
				}}
			>
				<svg
					role="img"
					aria-label={`Service dependency graph: ${nodes.length} nodes, ${edges.length} edges`}
					width={layout.width + PADDING * 2}
					height={layout.height + PADDING * 2}
					// Cards sit above this layer and take their own events; only the
					// edges' hit paths opt back in.
					className="pointer-events-none absolute inset-0"
				>
					<defs>
						{[...markers].map(([color, id]) => (
							<Arrowhead key={id} id={id} color={color} />
						))}
					</defs>
					<g transform={`translate(${PADDING}, ${PADDING})`}>
						{routed.map((route) => (
							<g key={route.edge.id} className={cn(isDimmed(route.edge) && "opacity-15")}>
								<path
									d={route.d}
									fill="none"
									stroke={route.color}
									strokeWidth={route.width}
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeOpacity={route.failing ? 0.9 : 0.55}
									strokeDasharray={route.reversed ? "5 4" : undefined}
									markerEnd={`url(#${markers.get(route.color)})`}
								/>
								{reducedMotion ? null : (
									<FlowDots route={route} maxCallCount={maxCallCount} />
								)}
								{labelled.has(route.edge.id) ? (
									<text
										x={route.mid.x}
										y={route.mid.y - 6}
										textAnchor="middle"
										// Painting the stroke first makes it a halo behind the
										// glyphs rather than an outline over them.
										stroke="var(--card)"
										strokeWidth={3}
										paintOrder="stroke"
										className="fill-muted-foreground text-[10px] font-medium tabular-nums"
									>
										{formatRateLabel(
											perSecond(route.edge.callCount, windowSeconds),
											route.edge.kind === "database" ? "calls" : "req",
										)}
									</text>
								) : null}
								<path
									d={route.d}
									fill="none"
									stroke="transparent"
									strokeWidth={16}
									className="pointer-events-auto"
									onMouseEnter={() =>
										setHovered({
											kind: "edge",
											edge: route.edge,
											x: route.mid.x,
											y: route.mid.y,
										})
									}
									onMouseLeave={() => setHovered(null)}
								>
									<title>{`${labelFor(byId, route.edge.source)} → ${labelFor(byId, route.edge.target)}: ${formatNumber(route.edge.callCount)} calls`}</title>
								</path>
							</g>
						))}
					</g>
				</svg>

				{nodes.map((node) => {
					const placed = layout.byId.get(node.id)
					if (!placed) return null
					return (
						<NodeCard
							key={node.id}
							node={node}
							placed={placed}
							windowSeconds={windowSeconds}
							selected={selectedId === node.id}
							dimmed={selectedId !== null && !touches(edges, selectedId, node.id)}
							onHover={(on) =>
								setHovered(on ? { kind: "node", node, x: placed.x, y: placed.y } : null)
							}
							onSelect={() => setSelectedId(node.id === selectedId ? null : node.id)}
							onOpen={node.serviceName ? () => onSelectService(node.serviceName!) : undefined}
						/>
					)
				})}

				{/* The selected node's card is pinned and interactive — it is the one
				    that carries the link into the service. The hover cards below it
				    are read-only and never take the pointer. */}
				{selected && selectedPlaced ? (
					<Popover x={selectedPlaced.x} y={selectedPlaced.y} interactive>
						<NodeTooltip
							node={selected}
							windowSeconds={windowSeconds}
							onOpen={
								selected.serviceName
									? () => onSelectService(selected.serviceName!)
									: undefined
							}
						/>
					</Popover>
				) : null}

				{hovered && !(hovered.kind === "node" && hovered.node.id === selectedId) ? (
					<Popover x={hovered.x} y={hovered.y}>
						{hovered.kind === "node" ? (
							<NodeTooltip node={hovered.node} windowSeconds={windowSeconds} />
						) : (
							<EdgeTooltip edge={hovered.edge} nodes={byId} windowSeconds={windowSeconds} />
						)}
					</Popover>
				) : null}
			</div>
		</div>
	)
}

/**
 * Above the thing it describes and clear of the pointer, so moving onto the
 * card cannot flicker the hover it is describing — except in the top row, where
 * above is off the canvas and it goes below.
 */
function Popover({
	x,
	y,
	interactive,
	children,
}: {
	x: number
	y: number
	interactive?: boolean
	children: ReactNode
}) {
	return (
		<div
			className={cn(
				"absolute z-20 w-60 -translate-x-1/2 rounded-md border bg-popover p-2 text-popover-foreground shadow-md",
				interactive ? "pointer-events-auto" : "pointer-events-none",
				y < TOOLTIP_FLIP_Y ? "translate-y-[52px]" : "-translate-y-[calc(100%+48px)]",
			)}
			style={{ left: x + PADDING, top: y + PADDING }}
		>
			{children}
		</div>
	)
}

/**
 * A service (or database) as a card: an accent bar in the service's own colour,
 * its name, and the three numbers the hosted map puts on one — throughput,
 * error share, mean latency. A database has no throughput of its own, so its
 * columns are the calls made to it.
 */
function NodeCard({
	node,
	placed,
	windowSeconds,
	selected,
	dimmed,
	onHover,
	onSelect,
	onOpen,
}: {
	node: ServiceMapNode
	placed: LayoutNode
	windowSeconds: number
	selected: boolean
	dimmed: boolean
	onHover: (on: boolean) => void
	onSelect: () => void
	onOpen?: () => void
}) {
	const failing = node.errorRate > EDGE_ERROR_THRESHOLD
	const color = getServiceColor(node.label)
	const isDatabase = node.kind === "database"
	const rate = perSecond(node.spanCount, windowSeconds)

	return (
		<div
			className={cn("absolute transition-opacity", dimmed && "opacity-40")}
			style={{
				left: placed.x - NODE_WIDTH / 2 + PADDING,
				top: placed.y - NODE_HEIGHT / 2 + PADDING,
				width: NODE_WIDTH,
				height: NODE_HEIGHT,
			}}
		>
			<button
				type="button"
				aria-pressed={selected}
				aria-label={`${node.label}: ${formatRate(rate)} ${isDatabase ? "calls" : "requests"} per second, ${formatErrorRate(node.errorRate)} errors, ${node.avgMs === null ? "no" : formatLatency(node.avgMs)} average latency`}
				title={onOpen ? `${node.label} — double-click to open the service` : node.label}
				onClick={onSelect}
				onDoubleClick={onOpen}
				onMouseEnter={() => onHover(true)}
				onMouseLeave={() => onHover(false)}
				onFocus={() => onHover(true)}
				onBlur={() => onHover(false)}
				className={cn(
					"relative flex size-full flex-col justify-center gap-1.5 overflow-hidden rounded-lg border bg-card py-2 pr-2.5 pl-4 text-left shadow-sm outline-none transition-[border-color,box-shadow]",
					"hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring",
					failing && "border-destructive/60",
					selected && "border-primary ring-2 ring-primary/40",
				)}
			>
				{/* The accent bar, and the dot beside the name: the same colour the
				    service has in every other view, twice, because at this size the
				    dot alone is four pixels of identity. */}
				<span
					aria-hidden
					className="absolute inset-y-0 left-0 w-1.5"
					style={{ backgroundColor: color }}
				/>
				<span className="flex items-center gap-1.5">
					<span
						aria-hidden
						className="size-2 shrink-0 rounded-[35%] [corner-shape:squircle]"
						style={{ backgroundColor: color }}
					/>
					<span className="min-w-0 flex-1 truncate text-[12px] font-medium">{node.label}</span>
					{isDatabase ? (
						<span
							title={node.dbSystem || "database"}
							className="shrink-0 rounded border px-1 text-[9px] font-medium tracking-wide text-muted-foreground uppercase"
						>
							DB
						</span>
					) : null}
				</span>
				<span className={cn("grid gap-1", isDatabase ? "grid-cols-2" : "grid-cols-3")}>
					<CardStat label={isDatabase ? "Calls/s" : "Req/s"} value={formatRate(rate)} />
					{isDatabase ? null : (
						<CardStat label="Errs" value={formatErrorRate(node.errorRate)} danger={failing} />
					)}
					<CardStat label="Avg" value={node.avgMs === null ? "—" : formatLatency(node.avgMs)} />
				</span>
			</button>
		</div>
	)
}

function CardStat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
	return (
		<span className="flex min-w-0 flex-col leading-none">
			<span className="truncate text-[8.5px] tracking-wider text-muted-foreground uppercase">
				{label}
			</span>
			<span className={cn("mt-0.5 truncate text-[11px] tabular-nums", danger && "text-destructive")}>
				{value}
			</span>
		</span>
	)
}

/**
 * Dots travelling the edge, as SVG motion rather than a render loop: the
 * browser interpolates along the very path the edge already drew, off the main
 * thread, and a map of forty edges costs one animation each instead of forty
 * state updates per frame. Busier edges move faster and carry more dots — the
 * animation IS the throughput reading, so it has to agree with the label.
 */
function FlowDots({ route, maxCallCount }: { route: RoutedEdge; maxCallCount: number }) {
	if (route.edge.callCount <= 0 || maxCallCount <= 0) return null
	const share = Math.min(1, Math.sqrt(route.edge.callCount / maxCallCount))
	const duration = FLOW_SECONDS_SLOW - (FLOW_SECONDS_SLOW - FLOW_SECONDS_FAST) * share
	const count = Math.max(1, Math.min(FLOW_MAX_DOTS, Math.ceil(share * FLOW_MAX_DOTS)))
	return (
		<>
			{Array.from({ length: count }, (_, i) => (
				<circle key={i} r={2.2} fill={route.color} opacity={0.85}>
					<animateMotion
						path={route.d}
						dur={`${duration.toFixed(2)}s`}
						begin={`${((i * duration) / count).toFixed(2)}s`}
						repeatCount="indefinite"
					/>
				</circle>
			))}
		</>
	)
}

function Arrowhead({ id, color }: { id: string; color: string }) {
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
			<path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
		</marker>
	)
}

function NodeTooltip({
	node,
	windowSeconds,
	onOpen,
}: {
	node: ServiceMapNode
	windowSeconds: number
	onOpen?: () => void
}) {
	const isDatabase = node.kind === "database"
	return (
		<>
			<p className="truncate text-xs font-medium">{node.label}</p>
			<p className="mb-1 text-[10px] tracking-wide text-muted-foreground uppercase">
				{isDatabase ? node.dbSystem || "database" : "service"}
			</p>
			<TooltipRow
				label={isDatabase ? "Calls/s" : "Req/s"}
				value={formatRate(perSecond(node.spanCount, windowSeconds))}
			/>
			<TooltipRow label={isDatabase ? "Calls" : "Spans"} value={formatNumber(node.spanCount)} />
			<TooltipRow
				label="Error rate"
				value={formatErrorRate(node.errorRate)}
				danger={node.errorRate > EDGE_ERROR_THRESHOLD}
			/>
			<TooltipRow label="Avg" value={node.avgMs === null ? "—" : formatLatency(node.avgMs)} />
			<TooltipRow label={isDatabase ? "p95 (slowest edge)" : "p95"} value={formatLatency(node.p95Ms)} />
			{onOpen ? (
				<button
					type="button"
					onClick={onOpen}
					className="mt-1.5 text-[11px] text-primary hover:underline"
				>
					Open service →
				</button>
			) : null}
		</>
	)
}

function EdgeTooltip({
	edge,
	nodes,
	windowSeconds,
}: {
	edge: ServiceMapEdge
	nodes: ReadonlyMap<string, ServiceMapNode>
	windowSeconds: number
}) {
	return (
		<>
			<p className="truncate text-xs font-medium">
				{labelFor(nodes, edge.source)} → {labelFor(nodes, edge.target)}
			</p>
			<TooltipRow
				label={edge.kind === "database" ? "Calls/s" : "Req/s"}
				value={formatRate(perSecond(edge.callCount, windowSeconds))}
			/>
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

/**
 * Every edge, routed: which port of which card it leaves, the path between
 * them, its colour and its weight.
 *
 * Ports fan across a card's height rather than all meeting its centre, ordered
 * by the row of the far end so the fan does not cross itself. An edge is drawn
 * in its SOURCE service's colour — read along a line and you are reading one
 * service's outbound traffic — tinted towards the destructive tone once enough
 * of its calls are failing that the failure is the more important fact.
 */
function routeEdges(
	edges: readonly ServiceMapEdge[],
	layout: ReturnType<typeof layoutServiceMap>,
	byId: ReadonlyMap<string, ServiceMapNode>,
	reversed: ReadonlySet<unknown>,
	maxCallCount: number,
): RoutedEdge[] {
	const drawable = edges.filter((edge) => layout.byId.has(edge.source) && layout.byId.has(edge.target))
	const rowOf = (id: string) => layout.byId.get(id)?.y ?? 0

	const startOffsets = new Map<string, number>()
	const endOffsets = new Map<string, number>()
	const group = (key: (edge: ServiceMapEdge) => string, far: (edge: ServiceMapEdge) => string) => {
		const groups = new Map<string, ServiceMapEdge[]>()
		for (const edge of drawable) {
			const list = groups.get(key(edge))
			if (list) list.push(edge)
			else groups.set(key(edge), [edge])
		}
		for (const list of groups.values()) {
			list.sort((a, b) => rowOf(far(a)) - rowOf(far(b)) || a.id.localeCompare(b.id))
		}
		return groups
	}

	for (const list of group(
		(edge) => edge.source,
		(edge) => edge.target,
	).values()) {
		const offsets = portOffsets(list.length, NODE_HEIGHT)
		list.forEach((edge, i) => startOffsets.set(edge.id, offsets[i]))
	}
	for (const list of group(
		(edge) => edge.target,
		(edge) => edge.source,
	).values()) {
		const offsets = portOffsets(list.length, NODE_HEIGHT)
		list.forEach((edge, i) => endOffsets.set(edge.id, offsets[i]))
	}

	return drawable.map((edge): RoutedEdge => {
		const from = layout.byId.get(edge.source)!
		const to = layout.byId.get(edge.target)!
		const startOffsetY = startOffsets.get(edge.id) ?? 0
		const endOffsetY = endOffsets.get(edge.id) ?? 0
		const failing = edge.errorRate > EDGE_ERROR_THRESHOLD
		const source = byId.get(edge.source)
		const base = getServiceColor(source?.label ?? edge.source)
		const backwards = to.x <= from.x
		const startX = from.x + (backwards ? -NODE_WIDTH / 2 : NODE_WIDTH / 2)
		const endX = to.x + (backwards ? NODE_WIDTH / 2 : -NODE_WIDTH / 2)
		return {
			edge,
			d: elbowPath(from, to, { nodeWidth: NODE_WIDTH, startOffsetY, endOffsetY }),
			mid: {
				x: (startX + endX) / 2,
				y: (from.y + startOffsetY + to.y + endOffsetY) / 2,
			},
			// Tinted, not replaced: a failing edge still says which service it left.
			color: failing ? `color-mix(in oklab, ${base} 25%, var(--destructive))` : base,
			failing,
			width: strokeWidth(edge.callCount, maxCallCount),
			reversed: reversed.has(edge),
		}
	})
}

/** Is `nodeId` the selected node, or one hop from it? */
function touches(edges: readonly ServiceMapEdge[], selectedId: string, nodeId: string): boolean {
	if (selectedId === nodeId) return true
	return edges.some(
		(edge) =>
			(edge.source === selectedId && edge.target === nodeId) ||
			(edge.target === selectedId && edge.source === nodeId),
	)
}

function labelFor(nodes: ReadonlyMap<string, ServiceMapNode>, id: string): string {
	return nodes.get(id)?.label ?? id
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
 * `prefers-reduced-motion`, live.
 *
 * The flow dots are SMIL, which CSS media queries cannot reach — there is no
 * `@media` rule that stops an `<animateMotion>`. So the preference is read here
 * and the dots are simply not rendered; nothing else about the map changes,
 * because nothing else about the map moves.
 */
function usePrefersReducedMotion(): boolean {
	const [reduced, setReduced] = useState(
		() => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
	)
	useEffect(() => {
		const query = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")
		if (!query) return
		const onChange = () => setReduced(query.matches)
		onChange()
		query.addEventListener("change", onChange)
		return () => query.removeEventListener("change", onChange)
	}, [])
	return reduced
}
