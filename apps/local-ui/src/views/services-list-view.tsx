import { DatabaseIcon } from "@maple/ui/components/icons"
import { LatencyValue } from "@maple/ui/components/latency-value"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { Badge } from "@maple/ui/components/ui/badge"
import { Sparkline } from "@maple/ui/components/ui/gradient-chart"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { formatErrorRate } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { FilterSection, SearchableFilterSection } from "@maple/ui/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import { useLocalServiceList, type ServiceSparkPoint } from "../hooks/use-local-service-catalog"
import {
	filterServiceRows,
	formatThroughput,
	groupByEnvironment,
	isServiceHealth,
	NO_ENVIRONMENT,
	serviceCountLabel,
	serviceListFacets,
	type ServiceHealth,
	type ServiceListRow,
} from "../lib/services-list"
import { useQueryParams } from "../lib/router"
import { DEFAULT_RANGE, formatRelativeTime } from "../lib/time"
import { PageShell } from "../components/page-shell"
import {
	RefreshButton,
	TimeRangeSelect,
	Toolbar,
	ToolbarSearch,
	ToolbarStat,
	ToolbarStats,
} from "../components/toolbar"
import { EmptyState, ErrorState, ListSkeleton } from "../components/view-states"

interface ServicesListViewProps {
	onSelectService: (serviceName: string) => void
}

export function ServicesListView({ onSelectService }: ServicesListViewProps) {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || DEFAULT_RANGE
	const env = query.get("env") || undefined
	const ns = query.get("ns") || undefined
	const version = query.get("version") || undefined
	const rawHealth = query.get("health") || undefined
	const health: ServiceHealth | undefined =
		rawHealth !== undefined && isServiceHealth(rawHealth) ? rawHealth : undefined
	const search = query.get("q") || undefined

	const list = useLocalServiceList(range)
	const all = list.data?.rows ?? []
	const filters = { env, ns, version, health, search }
	const rows = filterServiceRows(all, filters)
	const facets = serviceListFacets(all, filters)
	const groups = groupByEnvironment(rows)
	const hasActiveFilters = !!env || !!ns || !!version || !!health

	const unhealthyCount = rows.filter((row) => row.health === "unhealthy").length
	const degradedCount = rows.filter((row) => row.health === "degraded").length

	const sidebar = (
		<FilterSidebarFrame className="w-56 shrink-0 px-4" waiting={list.isFetching}>
			<FilterSidebarHeader
				canClear={hasActiveFilters}
				onClear={() => setParams({ env: null, ns: null, version: null, health: null })}
			/>
			<FilterSidebarBody>
				{/* Derived from the same rows the table paints, so a count here and a
				    badge there can never disagree. */}
				<FilterSection
					title="Health"
					options={facets.health}
					selected={health ? [health] : []}
					onChange={(values) => {
						// Single-select semantics on a multi-select control: the newly
						// ticked value wins, unticking clears.
						const next = values.find((value) => value !== health)
						setParams({ health: next !== undefined && isServiceHealth(next) ? next : null })
					}}
				/>
				<SearchableFilterSection
					title="Environment"
					options={facets.environments}
					selected={env ? [env] : []}
					onChange={(values) => setParams({ env: values.at(-1) ?? null })}
				/>
				{facets.namespaces.length > 0 && (
					<SearchableFilterSection
						title="Namespace"
						options={facets.namespaces}
						selected={ns ? [ns] : []}
						onChange={(values) => setParams({ ns: values.at(-1) ?? null })}
					/>
				)}
				{facets.versions.length > 0 && (
					<SearchableFilterSection
						title="Version"
						options={facets.versions}
						selected={version ? [version] : []}
						onChange={(values) => setParams({ version: values.at(-1) ?? null })}
					/>
				)}
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const toolbar = (
		<Toolbar>
			<ToolbarSearch
				query={search ?? ""}
				onSearch={(value) => setParams({ q: value ?? null })}
				placeholder="Filter by service name…"
			/>
			<ToolbarStats>
				<ToolbarStat value={rows.length} label="services" />
				<ToolbarStat value={unhealthyCount} label="unhealthy" danger />
				<RefreshButton />
				<TimeRangeSelect value={range} onChange={(next) => setParams({ range: next })} />
			</ToolbarStats>
		</Toolbar>
	)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar}>
			{list.isPending ? (
				<ListSkeleton rows={8} />
			) : list.isError ? (
				<ErrorState label="services" error={list.error} onRetry={() => list.refetch()} />
			) : rows.length === 0 ? (
				<EmptyState
					icon={<DatabaseIcon />}
					title={hasActiveFilters || search ? "No matching services" : "No services seen yet"}
					hint={
						hasActiveFilters || search
							? "Try widening the time range or clearing filters."
							: "Services appear as soon as their traces arrive."
					}
				/>
			) : (
				<div className="space-y-2 p-4">
					<div className="rounded-md border">
						{/* Fixed layout: the metric columns hold their widths and the
						    Service column absorbs the rest, truncating long names, so the
						    table fits its column rather than scrolling sideways. */}
						<Table aria-label="Services" className="w-full table-fixed">
							<TableHeader>
								<TableRow>
									<TableHead>Service</TableHead>
									<TableHead className="w-[8%]">P50</TableHead>
									<TableHead className="w-[10%]">P95</TableHead>
									<TableHead className="w-[8%]">P99</TableHead>
									<TableHead className="w-[13%]">Error Rate</TableHead>
									<TableHead className="w-[13%]">Throughput</TableHead>
									<TableHead className="w-[18%]">Last deploy</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{groups.map(([environment, group]) => (
									<EnvironmentGroup
										key={environment || "__none__"}
										environment={environment}
										rows={group}
										series={list.data?.series}
										onSelectService={onSelectService}
									/>
								))}
							</TableBody>
						</Table>
					</div>
					<div className="flex items-center justify-between px-1 text-sm text-muted-foreground">
						<span>Showing {serviceCountLabel(rows.length)}</span>
						{(unhealthyCount > 0 || degradedCount > 0) && (
							<span className="text-xs">
								{unhealthyCount > 0 ? `${unhealthyCount} unhealthy` : null}
								{unhealthyCount > 0 && degradedCount > 0 ? " · " : null}
								{degradedCount > 0 ? `${degradedCount} degraded` : null}
							</span>
						)}
					</div>
				</div>
			)}
		</PageShell>
	)
}

const ENVIRONMENT_BADGE_CLASS: Record<string, string> = {
	production: "bg-severity-warn/15 text-severity-warn",
	staging: "bg-chart-p50/15 text-chart-p50",
	development: "bg-severity-debug/15 text-severity-debug",
} satisfies Record<string, string>

/**
 * A group header per environment, and none at all for the rows that carry no
 * `deployment.environment` — a badge reading "unknown" would look like a value
 * somebody set. The count still says how many rows are down there.
 */
function EnvironmentGroup({
	environment,
	rows,
	series,
	onSelectService,
}: {
	environment: string
	rows: readonly ServiceListRow[]
	series: ReadonlyMap<string, ServiceSparkPoint[]> | undefined
	onSelectService: (serviceName: string) => void
}) {
	return (
		<>
			<TableRow className="bg-muted/30 hover:bg-muted/30">
				<TableCell colSpan={7} className="py-2">
					<div className="flex items-center gap-2">
						{environment !== NO_ENVIRONMENT && (
							<Badge
								variant="secondary"
								className={ENVIRONMENT_BADGE_CLASS[environment.toLowerCase()] ?? ""}
							>
								{environment}
							</Badge>
						)}
						<span className="text-xs text-muted-foreground">
							{serviceCountLabel(rows.length)}
						</span>
					</div>
				</TableCell>
			</TableRow>
			{rows.map((row) => (
				<ServiceRow
					key={`${row.serviceName}::${row.environment}`}
					row={row}
					series={series?.get(row.serviceName)}
					onSelect={() => onSelectService(row.serviceName)}
				/>
			))}
		</>
	)
}

const HEALTH_DOT_CLASS: Record<ServiceHealth, string> = {
	healthy: "bg-success",
	degraded: "bg-severity-warn",
	unhealthy: "bg-destructive",
} satisfies Record<ServiceHealth, string>

/** Quiet marker beside the name, drawn only when there is something to say. */
function HealthDot({ health }: { health: ServiceHealth }) {
	if (health === "healthy") return null
	return (
		<span
			aria-label={health}
			title={health}
			className={cn("size-1.5 shrink-0 rounded-full", HEALTH_DOT_CLASS[health])}
		/>
	)
}

/**
 * A sparkline with its headline number centred on top of it, the hosted table's
 * shape. The glow is a text-shadow in the background colour rather than a plate
 * behind the text, so the line stays visible either side of the digits.
 */
function SparklineCell({
	points,
	color,
	label,
	sublabel,
	ariaLabel,
}: {
	points: readonly number[]
	color: string
	label: string
	sublabel?: string | undefined
	ariaLabel: string
}) {
	return (
		<div className="relative h-8 w-full max-w-[120px]" role="img" aria-label={ariaLabel}>
			<Sparkline
				data={points.map((value) => ({ value }))}
				color={color}
				className="absolute inset-0 h-full w-full"
			/>
			<div className="absolute inset-0 flex flex-col items-center justify-center">
				<span className="font-mono text-xs font-semibold [text-shadow:0_0_6px_var(--background),0_0_12px_var(--background),0_0_18px_var(--background)]">
					{label}
				</span>
				{sublabel !== undefined && (
					<span className="font-mono text-[9px] text-muted-foreground [text-shadow:0_0_6px_var(--background),0_0_12px_var(--background),0_0_18px_var(--background)]">
						{sublabel}
					</span>
				)}
			</div>
		</div>
	)
}

/**
 * "Last deploy", answered with what a local store actually has.
 *
 * The hosted column resolves `vcs.ref.head.revision` against the VCS
 * integration and prints the commit subject with its diffstat. Local mode has
 * neither the integration nor, usually, the attribute — so the release it can
 * name is `service.version`, and the date beside it is when this window first
 * saw that version rather than when it was deployed. The wording says "seen"
 * for exactly that reason: the window clamps it, and a version that predates
 * the range would otherwise claim to have shipped at the range's start.
 */
function DeployCell({ row }: { row: ServiceListRow }) {
	if (row.version === "" && row.commitSha === "") {
		return <span className="text-xs text-muted-foreground">N/A</span>
	}
	const headline = row.version !== "" ? row.version : row.commitSha.slice(0, 7)
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<span className="truncate font-mono text-xs text-foreground" title={headline}>
				{headline}
			</span>
			{row.versionFirstSeen !== "" && (
				<span className="truncate text-[10px] text-muted-foreground">
					seen {formatRelativeTime(row.versionFirstSeen)}
				</span>
			)}
		</div>
	)
}

function ServiceRow({
	row,
	series,
	onSelect,
}: {
	row: ServiceListRow
	series: readonly ServiceSparkPoint[] | undefined
	onSelect: () => void
}) {
	return (
		<TableRow
			tabIndex={0}
			onClick={onSelect}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault()
					onSelect()
				}
			}}
			className={cn(
				"cursor-pointer border-l-2 border-l-transparent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
				row.health === "unhealthy" && "border-l-destructive",
			)}
		>
			<TableCell>
				<span className="flex max-w-full items-center gap-1.5">
					<ServiceDot serviceName={row.serviceName} />
					<span className="min-w-0 truncate font-medium" title={row.serviceName}>
						{row.serviceName}
					</span>
					<HealthDot health={row.health} />
				</span>
				{row.serviceNamespace !== "" && (
					<div className="truncate text-xs text-muted-foreground">{row.serviceNamespace}</div>
				)}
			</TableCell>
			<TableCell className="text-xs">
				<LatencyValue ms={row.p50LatencyMs} scale="p50" />
			</TableCell>
			<TableCell className="text-xs">
				<div>
					<LatencyValue ms={row.p95LatencyMs} scale="p95" />
				</div>
				{row.delta !== undefined && (
					<div className={cn("text-[10px] tabular-nums", row.delta.className)}>
						{row.delta.label}
					</div>
				)}
			</TableCell>
			<TableCell className="text-xs">
				<LatencyValue ms={row.p99LatencyMs} scale="p99" />
			</TableCell>
			<TableCell>
				<SparklineCell
					points={series?.map((point) => point.errorRate) ?? []}
					color="var(--color-destructive, #ef4444)"
					label={formatErrorRate(row.errorRate)}
					ariaLabel={`Error rate: ${formatErrorRate(row.errorRate)}`}
				/>
			</TableCell>
			<TableCell>
				<SparklineCell
					points={series?.map((point) => point.throughput) ?? []}
					color="var(--color-primary, #3b82f6)"
					label={`${row.hasSampling ? "~" : ""}${formatThroughput(row.throughput)}`}
					sublabel={
						row.hasSampling ? `~${formatThroughput(row.tracedThroughput)} traced` : undefined
					}
					ariaLabel={`Throughput: ${formatThroughput(row.throughput)}`}
				/>
			</TableCell>
			<TableCell>
				<DeployCell row={row} />
			</TableCell>
		</TableRow>
	)
}
