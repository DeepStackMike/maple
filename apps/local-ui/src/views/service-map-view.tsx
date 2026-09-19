// Service map — who calls whom, over the selected range.
//
// The canvas is the headline: a titled strip over the drawing, a footer under
// it with the map's shape and the one thing worth saying about this window.
// The edge table beside it is not a fallback — it is the same rows sorted by
// volume, readable without a pointer and without colour, and it is where an
// exact number lives. The drawing is in `components/service-map-graph.tsx`; the
// layout it needs is in `lib/service-map-layout.ts`.

import { useId } from "react"
import { SitemapIcon } from "@maple/ui/components/icons"
import { LatencyValue } from "@maple/ui/components/latency-value"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { Label } from "@maple/ui/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@maple/ui/components/ui/native-select"
import { Switch } from "@maple/ui/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { EDGE_ERROR_THRESHOLD, ServiceMapGraph } from "../components/service-map-graph"
import { RefreshButton, TimeRangeSelect, Toolbar, ToolbarStat, ToolbarStats } from "../components/toolbar"
import { EmptyState, ErrorState, ListSkeleton } from "../components/view-states"
import { useLocalServiceCatalog } from "../hooks/use-local-service-catalog"
import { useLocalServiceMap, type ServiceMapEdge, type ServiceMapNode } from "../hooks/use-local-service-map"
import { useQueryParams } from "../lib/router"
import { formatInsight, selectInsight } from "../lib/service-map-stats"
import { DEFAULT_RANGE } from "../lib/time"

interface ServiceMapViewProps {
	onSelectService: (serviceName: string) => void
}

export function ServiceMapView({ onSelectService }: ServiceMapViewProps) {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || DEFAULT_RANGE
	const env = query.get("env") || undefined
	// Live is in the hash like every other filter, so a reload keeps it and a
	// pasted link arrives live. The param names the exception, so an ordinary
	// link still carries no `live`.
	const live = query.get("live") === "1"

	const map = useLocalServiceMap({ range, env, live })
	// The environment list is the services catalog's, not the map's: filtering
	// the map by an environment removes the very rows the other options would
	// have come from, and a select that empties itself on use is a trap.
	const catalog = useLocalServiceCatalog({ range })
	const environments = catalog.data?.envFacets ?? []

	const nodes = map.data?.nodes ?? []
	const edges = map.data?.edges ?? []
	// Not `window`: the global is one typo away and this is a map window.
	const mapWindow = map.data?.window

	const toolbar = (
		<Toolbar>
			<div className="flex items-center gap-2">
				<span className="text-xs text-muted-foreground">Environment</span>
				<NativeSelect
					size="sm"
					aria-label="Deployment environment"
					value={env ?? ""}
					onChange={(event) => setParams({ env: event.target.value || null })}
				>
					<NativeSelectOption value="">All environments</NativeSelectOption>
					{environments.map((facet) => (
						<NativeSelectOption key={facet.name} value={facet.name}>
							{facet.name}
						</NativeSelectOption>
					))}
					{/* A link can carry an environment the current range has no rows
					    for; listing it keeps the select showing what is in effect. */}
					{env && !environments.some((facet) => facet.name === env) ? (
						<NativeSelectOption value={env}>{env}</NativeSelectOption>
					) : null}
				</NativeSelect>
			</div>
			<ToolbarStats>
				<ToolbarStat value={nodes.length} label="nodes" />
				<ToolbarStat value={edges.length} label="edges" />
				<ToolbarStat
					value={edges.filter((edge) => edge.errorRate > EDGE_ERROR_THRESHOLD).length}
					label="failing"
					danger
				/>
				<LiveToggle live={live} onChange={(next) => setParams({ live: next ? "1" : null })} />
				<RefreshButton />
				<TimeRangeSelect value={range} onChange={(next) => setParams({ range: next })} />
			</ToolbarStats>
		</Toolbar>
	)

	return (
		<div className="flex h-full flex-col">
			{toolbar}
			<div className="min-h-0 flex-1 overflow-auto">
				{map.isPending ? (
					<ListSkeleton rows={6} />
				) : map.isError ? (
					<ErrorState label="the service map" error={map.error} onRetry={() => map.refetch()} />
				) : nodes.length === 0 ? (
					<EmptyState
						icon={<SitemapIcon />}
						title={
							live
								? "Nothing in the last 60 seconds"
								: env
									? `No traffic in ${env}`
									: "No service traffic yet"
						}
						hint={
							live
								? "Live mode only shows the last minute. Turn it off to widen the window."
								: env
									? "Try another environment, or widen the time range."
									: "The map is drawn from client and server spans — it fills in as soon as one service calls another."
						}
					/>
				) : (
					<div className="flex flex-col gap-4 p-4 xl:flex-row xl:items-start">
						<section className="flex min-w-0 flex-1 flex-col rounded-md border bg-card/40">
							<CanvasHeader label={mapWindow?.label ?? range.toUpperCase()} live={live} />
							<div className="min-h-0 flex-1">
								<ServiceMapGraph
									nodes={nodes}
									edges={edges}
									maxCallCount={map.data.maxCallCount}
									windowSeconds={mapWindow?.seconds ?? 0}
									onSelectService={onSelectService}
								/>
							</div>
							<CanvasFooter
								nodes={nodes}
								edges={edges}
								windowLabel={mapWindow?.label ?? range.toUpperCase()}
							/>
						</section>
						<EdgeTable
							edges={edges}
							nodes={nodes}
							dbEdgesUnavailable={map.data.dbEdgesUnavailable}
							onSelectService={onSelectService}
						/>
					</div>
				)}
			</div>
		</div>
	)
}

/**
 * Live is a window, not a refresh button: sixty seconds, re-read every five.
 * Spelled as what it turns on rather than as its state, so the label does not
 * change under the click that changes the switch.
 */
function LiveToggle({ live, onChange }: { live: boolean; onChange: (live: boolean) => void }) {
	const id = useId()
	return (
		<span className="flex items-center gap-1.5" title={LIVE_HINT}>
			<Switch id={id} checked={live} onCheckedChange={onChange} />
			<Label htmlFor={id} className="cursor-pointer text-xs font-normal whitespace-nowrap">
				Live
			</Label>
		</span>
	)
}

const LIVE_HINT = "Draw the map from the last 60 seconds, re-read every 5 seconds"

function CanvasHeader({ label, live }: { label: string; live: boolean }) {
	return (
		<header className="flex items-center justify-between border-b px-3 py-2">
			<h2 className="text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
				Service map · Last {label}
			</h2>
			{live ? (
				<span className="flex items-center gap-1.5 text-[10px] font-medium tracking-[0.12em] text-success uppercase">
					<span className="relative flex size-1.5">
						<span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75 motion-reduce:animate-none" />
						<span className="relative inline-flex size-1.5 rounded-full bg-success" />
					</span>
					Live
				</span>
			) : null}
		</header>
	)
}

/**
 * The map's shape on the left, and on the right the single line this window is
 * worth: whichever service's p95 moved furthest from the window before it.
 * Nothing moved enough, or nothing has a window before it to compare against —
 * then the strip carries the counts alone rather than a manufactured headline.
 */
function CanvasFooter({
	nodes,
	edges,
	windowLabel,
}: {
	nodes: readonly ServiceMapNode[]
	edges: readonly ServiceMapEdge[]
	windowLabel: string
}) {
	const insight = selectInsight(
		nodes.map((node) => ({
			label: node.label,
			kind: node.kind,
			p95Ms: node.p95Ms,
			previousP95Ms: node.previousP95Ms,
			spanCount: node.spanCount,
		})),
	)
	return (
		<footer className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
			<span className="tabular-nums">
				{nodes.length} services · {edges.length} edges · {windowLabel} window
			</span>
			{insight ? (
				<span className={cn("tabular-nums", insight.deltaRatio > 0 && "text-destructive")}>
					{formatInsight(insight, windowLabel)}
				</span>
			) : null}
		</footer>
	)
}

/**
 * Every edge in the drawing, as text. Sorted by call volume, which is also what
 * decides how thick each edge is drawn — so the top of this table is the
 * heaviest line on the map.
 */
function EdgeTable({
	edges,
	nodes,
	dbEdgesUnavailable,
	onSelectService,
}: {
	edges: readonly ServiceMapEdge[]
	nodes: readonly ServiceMapNode[]
	dbEdgesUnavailable: boolean
	onSelectService: (serviceName: string) => void
}) {
	const byId = new Map(nodes.map((node) => [node.id, node]))
	const sorted = [...edges].sort((a, b) => b.callCount - a.callCount)

	return (
		<section className="w-full shrink-0 xl:w-[460px]" aria-label="Service dependencies">
			<div className="rounded-md border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>From</TableHead>
							<TableHead>To</TableHead>
							<TableHead className="text-right">Calls</TableHead>
							<TableHead className="text-right">Errors</TableHead>
							<TableHead className="text-right">p95</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{sorted.length === 0 ? (
							<TableRow>
								<TableCell colSpan={5} className="text-center text-muted-foreground">
									No calls between services in this range.
								</TableCell>
							</TableRow>
						) : (
							sorted.map((edge) => (
								<TableRow key={edge.id}>
									<TableCell>
										<EndpointCell
											node={byId.get(edge.source)}
											id={edge.source}
											onSelectService={onSelectService}
										/>
									</TableCell>
									<TableCell>
										<EndpointCell
											node={byId.get(edge.target)}
											id={edge.target}
											onSelectService={onSelectService}
										/>
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{formatNumber(edge.callCount)}
									</TableCell>
									<TableCell
										className={cn(
											"text-right tabular-nums",
											edge.errorRate > EDGE_ERROR_THRESHOLD && "text-destructive",
										)}
									>
										{formatNumber(edge.errorCount)}
										<span className="ml-1 text-xs text-muted-foreground">
											({formatErrorRate(edge.errorRate)})
										</span>
									</TableCell>
									<TableCell className="text-right">
										<LatencyValue ms={edge.p95Ms} scale="p95" />
									</TableCell>
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</div>
			{dbEdgesUnavailable ? (
				<p className="mt-2 text-xs text-muted-foreground">
					Database edges couldn’t be read for this range; the service graph is unaffected.
				</p>
			) : null}
		</section>
	)
}

function EndpointCell({
	node,
	id,
	onSelectService,
}: {
	node: ServiceMapNode | undefined
	id: string
	onSelectService: (serviceName: string) => void
}) {
	const label = node?.label ?? id
	if (!node?.serviceName) {
		return (
			<span className="flex items-center gap-2 text-muted-foreground">
				<span className="truncate">{label}</span>
			</span>
		)
	}
	return (
		<button
			type="button"
			onClick={() => onSelectService(node.serviceName!)}
			className="flex max-w-full items-center gap-2 text-left hover:underline"
		>
			<ServiceDot serviceName={node.serviceName} />
			<span className="truncate">{label}</span>
		</button>
	)
}
