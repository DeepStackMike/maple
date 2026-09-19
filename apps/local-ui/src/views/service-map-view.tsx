// Service map — who calls whom, over the selected range.
//
// The graph is the headline, but the edge table beside it is not a fallback:
// it is the same rows sorted by volume, readable without a pointer and without
// colour, and it is where an exact number lives. The drawing is in
// `components/service-map-graph.tsx`; the layout it needs is in
// `lib/service-map-layout.ts`.

import { SitemapIcon } from "@maple/ui/components/icons"
import { LatencyValue } from "@maple/ui/components/latency-value"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { NativeSelect, NativeSelectOption } from "@maple/ui/components/ui/native-select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { EDGE_ERROR_THRESHOLD, ServiceMapGraph } from "../components/service-map-graph"
import { RefreshButton, TimeRangeSelect, Toolbar, ToolbarStat, ToolbarStats } from "../components/toolbar"
import { EmptyState, ErrorState, ListSkeleton } from "../components/view-states"
import { useLocalServiceCatalog } from "../hooks/use-local-service-catalog"
import { useLocalServiceMap, type ServiceMapEdge, type ServiceMapNode } from "../hooks/use-local-service-map"
import { useQueryParams } from "../lib/router"
import { DEFAULT_RANGE } from "../lib/time"

interface ServiceMapViewProps {
	onSelectService: (serviceName: string) => void
}

export function ServiceMapView({ onSelectService }: ServiceMapViewProps) {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || DEFAULT_RANGE
	const env = query.get("env") || undefined

	const map = useLocalServiceMap({ range, env })
	// The environment list is the services catalog's, not the map's: filtering
	// the map by an environment removes the very rows the other options would
	// have come from, and a select that empties itself on use is a trap.
	const catalog = useLocalServiceCatalog({ range })
	const environments = catalog.data?.envFacets ?? []

	const nodes = map.data?.nodes ?? []
	const edges = map.data?.edges ?? []

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
						title={env ? `No traffic in ${env}` : "No service traffic yet"}
						hint={
							env
								? "Try another environment, or widen the time range."
								: "The map is drawn from client and server spans — it fills in as soon as one service calls another."
						}
					/>
				) : (
					<div className="flex flex-col gap-4 p-4 xl:flex-row xl:items-start">
						<div className="min-w-0 flex-1 rounded-md border bg-card/40">
							<ServiceMapGraph
								nodes={nodes}
								edges={edges}
								maxCallCount={map.data.maxCallCount}
								onSelectService={onSelectService}
							/>
						</div>
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
											{formatErrorRate(edge.errorRate)}
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
