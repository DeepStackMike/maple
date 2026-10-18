import { HttpSpanLabel } from "@maple/ui/components/traces/http-span-label"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ListFooter } from "@maple/ui/components/ui/list-footer"
import { TableSkeleton } from "@maple/ui/components/ui/table-skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { EMPTY_VALUE, formatDuration, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { useIsMobile } from "@maple/ui/hooks/use-media-query"
import { useCallback, type MouseEvent } from "react"
import { useHideHealthChecks } from "../hooks/use-hide-health-checks"
import { useNamespace } from "../hooks/use-namespace"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { ServicePills } from "@maple/ui/components/service-pills"
import { TraceStatusBadge } from "@maple/ui/components/traces/trace-status-badge"
import { getHttpInfo } from "@maple/ui/lib/http"
import { DurationRangeFilter } from "@maple/ui/components/filters/duration-range-filter"
import {
	FilterSection,
	SearchableFilterSection,
	serviceColorMap,
	SingleCheckboxFilter,
} from "@maple/ui/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import { useLocalTraces, type TraceFilters, type TraceRow } from "../hooks/use-local-traces"
import { useLocalTraceFacets } from "../hooks/use-local-trace-facets"
import { useRange } from "../hooks/use-range"
import { useTimeWindow } from "../hooks/use-time-window"
import { hrefFor, navigate, useLocation, useQueryParams } from "../lib/router"
import {
	isPlainClick,
	openTraceQuery,
	PEEK_PARAM,
	PEEK_SPAN_PARAM,
	resolvePeek,
	stepTarget,
	withoutPeek,
} from "../lib/trace-peek"
import { formatLocalDateTime, formatRelativeTime, formatUtcTitle, WIDEST_RANGE } from "../lib/time"
import { PageShell } from "../components/page-shell"
import { LinkRow, RowLink } from "../components/row-link"
import { SignalEmptyState } from "../components/signal-empty-state"
import { TracePeekBody, TracePeekSheet } from "../components/trace-peek-sheet"
import {
	HideHealthChecksToggle,
	Toolbar,
	ToolbarSearch,
	ToolbarStat,
	ToolbarStats,
	TimeRangeSelect,
	RefreshButton,
} from "../components/toolbar"
import { ErrorState } from "../components/view-states"
import { failedWithoutData } from "../lib/query"

/** Parse a URL param as a non-negative integer; anything else means "unset". */
function parseNonNegativeInt(raw: string | null): number | undefined {
	if (!raw) return undefined
	const parsed = Number(raw)
	return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined
}

const FILTER_KEYS = [
	"service",
	"span",
	"errors",
	"method",
	"status",
	"env",
	"ns",
	"minDur",
	"maxDur",
] as const

export function TraceListView() {
	const [query, setParams] = useQueryParams()
	const [range, setRange] = useRange()
	const timeWindow = useTimeWindow(range)
	const spanScope = query.get("scope") === "spans"
	const search = query.get("q") || undefined
	const [hideHealthChecks, setHideHealthChecks] = useHideHealthChecks()
	// The header's project selection and this sidebar's Namespace facet are the
	// same filter under two controls — both are the `ns` param — so the list
	// reads the resolved value rather than the raw one, and a project remembered
	// from the last session shows here as a ticked facet.
	const [namespace, setNamespace] = useNamespace()

	const filters: TraceFilters = {
		search,
		hideHealthChecks,
		service: query.get("service") || undefined,
		span: query.get("span") || undefined,
		errorsOnly: query.get("errors") === "1",
		method: query.get("method") || undefined,
		status: query.get("status") || undefined,
		env: query.get("env") || undefined,
		ns: namespace,
		minDurationMs: parseNonNegativeInt(query.get("minDur")),
		maxDurationMs: parseNonNegativeInt(query.get("maxDur")),
		scope: spanScope ? "spans" : "root",
	}

	const facets = useLocalTraceFacets(filters, timeWindow.bounds, !spanScope)
	const traces = useLocalTraces(filters, timeWindow.bounds)
	const rows = traces.data?.pages.flat() ?? []

	// The peek: a plain click opens the trace in a sheet over the list. A phone
	// has no room for a sheet beside the list, so there a click takes the page.
	const { path } = useLocation()
	const peekEnabled = !useIsMobile()
	const peek = peekEnabled ? resolvePeek(rows, query.get(PEEK_PARAM)) : null
	const peekSpanId = query.get(PEEK_SPAN_PARAM) || undefined
	// Opening pushes a history entry (Back closes the sheet); stepping, span
	// selection and closing replace it, so walking fifty rows leaves no trail.
	const openPeek = useCallback(
		(traceId: string, opts?: { replace?: boolean }) => {
			const next = withoutPeek(new URLSearchParams(window.location.hash.split("?")[1] ?? ""))
			next.set(PEEK_PARAM, traceId)
			navigate(path, next, opts)
		},
		[path],
	)
	const stepPeek = (delta: 1 | -1) => {
		const next = stepTarget(rows, peek, delta)
		if (next) openPeek(next.traceId, { replace: true })
	}
	const closePeek = () => navigate(path, withoutPeek(query), { replace: true })
	const selectPeekSpan = (spanId: string | undefined) => setParams({ [PEEK_SPAN_PARAM]: spanId ?? null })
	const onRowClick = peekEnabled
		? (event: MouseEvent, traceId: string) => {
				// Only the row's own link: a modified, middle or right click keeps its
				// default (new tab, context menu), and so does any other control.
				if (!isPlainClick(event)) return
				if (!(event.target instanceof Element) || !event.target.closest("a[data-row-link]")) return
				event.preventDefault()
				openPeek(traceId)
			}
		: undefined

	const activeFilterCount = FILTER_KEYS.filter((key) => query.get(key)).length
	const clearFilters = () => {
		// Through the setter as well: clearing the facet has to clear the
		// remembered project, or the next render would resolve it straight back
		// out of `localStorage`.
		void setNamespace(undefined)
		setParams({ ...Object.fromEntries(FILTER_KEYS.map((key) => [key, null])), q: null, scope: null })
	}

	// Single-select facet adapter: the list query takes one value per dimension.
	const facetSelect = (key: string) => (vals: string[]) => setParams({ [key]: vals.at(-1) ?? null })

	const sidebar = spanScope ? (
		<FilterSidebarFrame className="w-56 shrink-0 px-4">
			<FilterSidebarHeader title="Span search" canClear onClear={clearFilters} />
			<FilterSidebarBody>
				<p className="py-1 text-xs text-muted-foreground">
					Matching any span in a trace, not only its root. Root-span facets are off in this mode.
				</p>
				<SingleCheckboxFilter
					title="Errored spans only"
					checked={filters.errorsOnly === true}
					onChange={(checked) => setParams({ errors: checked ? "1" : null })}
				/>
				<Button
					variant="outline"
					size="sm"
					className="mt-2 w-full"
					onClick={() => setParams({ scope: null })}
				>
					Filter root spans instead
				</Button>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	) : (
		<FilterSidebarFrame className="w-56 shrink-0 px-4" waiting={facets.isFetching}>
			<FilterSidebarHeader canClear={activeFilterCount > 0} onClear={clearFilters} />
			<FilterSidebarBody>
				<SingleCheckboxFilter
					title="Has error"
					checked={filters.errorsOnly === true}
					onChange={(checked) => setParams({ errors: checked ? "1" : null })}
					count={facets.data?.errorCount}
				/>
				<FilterSection
					title="Environment"
					options={facets.data?.deploymentEnvs ?? []}
					selected={filters.env ? [filters.env] : []}
					onChange={facetSelect("env")}
				/>
				<SearchableFilterSection
					title="Namespace"
					options={facets.data?.namespaces ?? []}
					selected={filters.ns ? [filters.ns] : []}
					onChange={(vals) => void setNamespace(vals.at(-1))}
				/>
				<SearchableFilterSection
					title="Service"
					options={facets.data?.services ?? []}
					selected={filters.service ? [filters.service] : []}
					onChange={facetSelect("service")}
					colorMap={serviceColorMap(facets.data?.services ?? [])}
				/>
				<SearchableFilterSection
					title="Root span"
					options={facets.data?.spanNames ?? []}
					selected={filters.span ? [filters.span] : []}
					onChange={facetSelect("span")}
				/>
				<DurationRangeFilter
					minValue={filters.minDurationMs}
					maxValue={filters.maxDurationMs}
					onRangeChange={(min, max) =>
						setParams({
							minDur: min != null ? String(Math.round(min)) : null,
							maxDur: max != null ? String(Math.round(max)) : null,
						})
					}
					durationStats={facets.data?.durationStats}
					debounceMs={300}
				/>
				<FilterSection
					title="HTTP method"
					options={facets.data?.httpMethods ?? []}
					selected={filters.method ? [filters.method] : []}
					onChange={facetSelect("method")}
				/>
				<FilterSection
					title="Status code"
					options={facets.data?.httpStatusCodes ?? []}
					selected={filters.status ? [filters.status] : []}
					onChange={facetSelect("status")}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const toolbar = (
		<Toolbar>
			{spanScope ? (
				<SpanScopeBanner
					service={filters.service}
					span={filters.span}
					onExit={() => setParams({ scope: null })}
				/>
			) : null}
			{spanScope && filters.span ? null : (
				<ToolbarSearch
					query={search ?? ""}
					onSearch={(value) => setParams({ q: value ?? null })}
					placeholder={spanScope ? "Filter by any span name…" : "Filter by span name…"}
					className="min-w-48 flex-1"
				/>
			)}
			<ToolbarStats className="shrink-0">
				<ToolbarStat value={rows.length} label={traces.hasNextPage ? "traces+" : "traces"} />
				<HideHealthChecksToggle hidden={hideHealthChecks} onChange={setHideHealthChecks} />
				<RefreshButton advance={timeWindow.advance} since={traces.dataUpdatedAt} />
				<TimeRangeSelect value={range} onChange={setRange} />
			</ToolbarStats>
		</Toolbar>
	)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar} activeFilterCount={activeFilterCount}>
			{traces.isPending ? (
				<TableSkeleton
					className="rounded-none border-0"
					rows={12}
					columns={[
						{ header: "Trace", headClassName: "w-[40%]", skeleton: "w-56" },
						{ header: "Services", skeleton: "w-40" },
						{ header: "Duration", headClassName: "text-right", skeleton: "ml-auto w-14" },
						{ header: "Spans", headClassName: "text-right", skeleton: "ml-auto w-8" },
						{ header: "Status", skeleton: "w-10" },
						{ header: "Started", headClassName: "text-right", skeleton: "ml-auto w-16" },
					]}
				/>
			) : failedWithoutData(traces) ? (
				<ErrorState label="traces" error={traces.error} onRetry={() => traces.refetch()} />
			) : rows.length === 0 ? (
				<SignalEmptyState
					signal="traces"
					filtered={activeFilterCount > 0 || !!search}
					onClearFilters={clearFilters}
					range={range}
					onWidenRange={() => setRange(WIDEST_RANGE)}
					detail={
						hideHealthChecks ? (
							<p className="text-xs text-muted-foreground">
								Health checks are hidden. If all this service serves is probes, untick “Hide
								health checks” to see them.
							</p>
						) : undefined
					}
				/>
			) : (
				<div className={cn(traces.isPlaceholderData && "opacity-60 transition-opacity")}>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="w-[40%]">Trace</TableHead>
								<TableHead>Services</TableHead>
								<TableHead className="text-right">Duration</TableHead>
								<TableHead className="text-right">Spans</TableHead>
								<TableHead>Status</TableHead>
								<TableHead className="text-right">Started</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((row) => (
								<TraceListRow
									key={row.traceId}
									row={row}
									query={withoutPeek(query)}
									active={row.traceId === peek?.traceId}
									onClick={onRowClick}
								/>
							))}
						</TableBody>
					</Table>

					<ListFooter
						hasMore={traces.hasNextPage}
						loading={traces.isFetchingNextPage}
						onLoadMore={() => traces.fetchNextPage()}
					/>
				</div>
			)}
			<TracePeekSheet
				traceId={peek?.traceId ?? null}
				position={peek?.position ?? null}
				onStep={stepPeek}
				onClose={closePeek}
				openHref={
					peek
						? hrefFor(
								`/traces/${encodeURIComponent(peek.traceId)}`,
								openTraceQuery(query, peekSpanId),
							)
						: "#"
				}
			>
				{peek ? (
					<TracePeekBody
						traceId={peek.traceId}
						selectedSpanId={peekSpanId}
						onSelectSpan={selectPeekSpan}
					/>
				) : null}
			</TracePeekSheet>
		</PageShell>
	)
}

function SpanScopeBanner({
	service,
	span,
	onExit,
}: {
	service: string | undefined
	span: string | undefined
	onExit: () => void
}) {
	return (
		<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
			<span className="text-muted-foreground">Traces containing a span</span>
			{service ? (
				<>
					<span className="text-muted-foreground">from</span>
					<Badge variant="outline" className="font-mono text-xs">
						<ServiceDot serviceName={service} size="sm" />
						{service}
					</Badge>
				</>
			) : null}
			{span ? (
				<>
					<span className="text-muted-foreground">named</span>
					<Badge variant="outline" className="max-w-64 truncate font-mono text-xs" title={span}>
						{span}
					</Badge>
				</>
			) : null}
			<Button variant="ghost" size="xs" onClick={onExit}>
				Root spans only
			</Button>
		</div>
	)
}

function TraceListRow({
	row,
	query,
	active,
	onClick,
}: {
	row: TraceRow
	query: URLSearchParams
	/** Open in the peek sheet. */
	active: boolean
	/** A click on the row's link, bubbled to its cell; absent when the peek is off. */
	onClick?: (event: MouseEvent, traceId: string) => void
}) {
	const href = hrefFor(`/traces/${encodeURIComponent(row.traceId)}`, query)
	const httpStatusCode = getHttpInfo({
		spanName: row.rootSpanName,
		spanKind: row.rootSpanKind,
		spanAttributes: row.rootSpanAttributes,
	})?.statusCode
	return (
		<LinkRow className={cn(row.hasError && "bg-severity-error/5", active && "bg-primary/5")}>
			{/* The link's hit area stretches over the whole row, so every click on the
			    row is a click on it, and it bubbles here. */}
			<TableCell
				className="min-w-0"
				onClick={onClick ? (event) => onClick(event, row.traceId) : undefined}
			>
				<RowLink
					href={href}
					label={`Trace ${row.rootSpanName || row.traceId}`}
					className="flex items-center gap-2"
				>
					{row.hasError ? (
						<span className="size-1.5 shrink-0 rounded-full bg-severity-error">
							<span className="sr-only">Errored</span>
						</span>
					) : null}
					<HttpSpanLabel
						spanName={row.rootSpanName}
						spanKind={row.rootSpanKind}
						spanAttributes={row.rootSpanAttributes}
						className="min-w-0"
						textClassName="text-xs"
					/>
				</RowLink>
			</TableCell>
			<TableCell>
				<ServicePills services={row.services} />
			</TableCell>
			<TableCell className="text-right font-mono tabular-nums">
				{formatDuration(row.durationMs)}
			</TableCell>
			<TableCell className="text-right font-mono tabular-nums text-muted-foreground">
				{row.spanCount === null ? EMPTY_VALUE : formatNumber(row.spanCount)}
			</TableCell>
			<TableCell>
				<TraceStatusBadge hasError={row.hasError} httpStatusCode={httpStatusCode} />
			</TableCell>
			<TableCell
				className="text-right text-xs whitespace-nowrap text-muted-foreground"
				title={`${formatLocalDateTime(row.startTime)} (${formatUtcTitle(row.startTime)})`}
			>
				{formatRelativeTime(row.startTime)}
			</TableCell>
		</LinkRow>
	)
}
