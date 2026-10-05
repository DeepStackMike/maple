import { useMemo, useState } from "react"
import { CircleWarningIcon, ChevronDownIcon, EyeIcon } from "@maple/ui/components/icons"
import { Badge } from "@maple/ui/components/ui/badge"
import { StatSparkline } from "@maple/ui/components/charts/sparkline/stat-sparkline"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { formatDuration, formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import {
	SearchableFilterSection,
	SingleCheckboxFilter,
	serviceColorMap,
} from "@maple/ui/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import type { CH } from "@maple/query-engine"
import {
	useLocalErrorSampleStack,
	useLocalErrorSessions,
	useLocalErrorTraces,
	useLocalErrorSlices,
	useLocalErrorVersions,
	useLocalVersionTraffic,
	useLocalErrorsByType,
	useLocalErrorsFacets,
	useLocalErrorsSpark,
	useLocalErrorsSummary,
	type ErrorsFilters,
	type ErrorTypeRow,
} from "../hooks/use-local-errors"
import { useRange } from "../hooks/use-range"
import { useSignalPresence } from "../hooks/use-signal-presence"
import { useTimeWindow } from "../hooks/use-time-window"
import { denseCounts, sparkWindow, type SparkPoint, type SparkWindow } from "../lib/error-spark"
import {
	compareErrorVersions,
	introducedIn,
	nothingCompared,
	versionsByRecency,
	type ComparedVersion,
	type ErrorSlice,
	type Introduction,
	type NotComparedReason,
	type VersionTraffic,
} from "../lib/error-versions"
import { hrefFor, useQueryParams } from "../lib/router"
import type { ProjectScope } from "../lib/project-scope"
import { useNamespaceServices } from "../hooks/use-namespace-services"
import { formatRelativeTime, WIDEST_RANGE, type TimeBounds } from "../lib/time"
import { detectLanguage } from "../lib/code-block"
import { CodeBlock } from "../components/code-block"
import { PageShell } from "../components/page-shell"
import { SignalEmptyState } from "../components/signal-empty-state"
import { StackTrace } from "../components/stack-trace"
import { RefreshButton, TimeRangeSelect, Toolbar, ToolbarStats } from "../components/toolbar"
import { EmptyState, ErrorState, ListSkeleton } from "../components/view-states"

/** What a `ServiceVersion` of `''` reads as: the exporter never set one. */
const UNVERSIONED = "unversioned"

const EMPTY_SLICES: ReadonlyArray<ErrorSlice> = []
const EMPTY_TRAFFIC: ReadonlyArray<VersionTraffic> = []

export function ErrorsView() {
	const [query, setParams] = useQueryParams()
	const [range, setRange] = useRange()
	const timeWindow = useTimeWindow(range)
	const filters: ErrorsFilters = {
		service: query.get("service") || undefined,
		env: query.get("env") || undefined,
		errorType: query.get("type") || undefined,
		version: query.get("version") || undefined,
		rootOnly: query.get("root") === "1",
	}
	// The header project, as its services: every errors query waits for it and
	// is intersected with the sidebar's service.
	const scope = useNamespaceServices(timeWindow.bounds)
	const summary = useLocalErrorsSummary(filters, timeWindow.bounds, scope)
	const byType = useLocalErrorsByType(filters, timeWindow.bounds, scope)
	const facets = useLocalErrorsFacets(filters, timeWindow.bounds, scope)
	const traces = useSignalPresence("traces")
	const activeFilterCount = [
		filters.service,
		filters.env,
		filters.errorType,
		filters.version,
		filters.rootOnly,
	].filter(Boolean).length
	const clearFilters = () => setParams({ service: null, env: null, type: null, version: null, root: null })

	const rows = byType.data ?? []
	// One query each for the whole page, built off the rendered rows so they
	// re-run when the list does, and skipped while the list is empty.
	const fingerprints = rows.map((row) => row.fingerprintHash)
	// Drawn window: the range the user asked for, ending at the page's anchor —
	// not the padded query bounds (see `error-spark.ts`).
	const spark = useMemo(() => sparkWindow(range, timeWindow.anchorMs), [range, timeWindow.anchorMs])
	const versions = useLocalErrorVersions(fingerprints, filters, timeWindow.bounds, scope)
	// Each version against the one it replaced on the same service and
	// environment: version traffic orders them, and the per-(service,
	// environment, version) split says how often this error fired on each side.
	const traffic = useLocalVersionTraffic(filters, timeWindow.bounds, scope)
	const slices = useLocalErrorSlices(fingerprints, filters, timeWindow.bounds, scope)
	const versionsPending = traffic.isPending || (fingerprints.length > 0 && slices.isPending)
	const sparkData = useLocalErrorsSpark(
		fingerprints,
		filters,
		timeWindow.bounds,
		spark.bucketSeconds,
		scope,
	)

	const sidebar = (
		<FilterSidebarFrame className="w-56 shrink-0 px-4" waiting={facets.isFetching}>
			<FilterSidebarHeader canClear={activeFilterCount > 0} onClear={clearFilters} />
			<FilterSidebarBody>
				<SingleCheckboxFilter
					title="Root spans only"
					checked={filters.rootOnly === true}
					onChange={(checked) => setParams({ root: checked ? "1" : null })}
				/>
				<SearchableFilterSection
					title="Service"
					options={facets.data?.services ?? []}
					selected={filters.service ? [filters.service] : []}
					onChange={(vals) => setParams({ service: vals.at(-1) ?? null })}
					colorMap={serviceColorMap(facets.data?.services ?? [])}
				/>
				<SearchableFilterSection
					title="Environment"
					options={facets.data?.environments ?? []}
					selected={filters.env ? [filters.env] : []}
					onChange={(vals) => setParams({ env: vals.at(-1) ?? null })}
				/>
				<SearchableFilterSection
					title="Error Type"
					options={facets.data?.errorTypes ?? []}
					selected={filters.errorType ? [filters.errorType] : []}
					onChange={(vals) => setParams({ type: vals.at(-1) ?? null })}
				/>
				{/* Which deploy the error was seen on — the fastest way to tell a
				    regression from something that was always broken. Blank versions
				    are dropped by `errorsFacetsQuery`. */}
				<SearchableFilterSection
					title="Version"
					options={facets.data?.versions ?? []}
					selected={filters.version ? [filters.version] : []}
					onChange={(vals) => setParams({ version: vals.at(-1) ?? null })}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const toolbar = (
		<Toolbar>
			<div className="min-w-0">
				<h2 className="text-sm font-medium">Errors</h2>
				<p className="truncate text-xs text-muted-foreground">
					Monitor and analyze errors across your services
				</p>
			</div>
			<ToolbarStats className="shrink-0">
				<RefreshButton advance={timeWindow.advance} since={byType.dataUpdatedAt} />
				<TimeRangeSelect value={range} onChange={setRange} />
			</ToolbarStats>
		</Toolbar>
	)

	const noDataAtAll = !byType.isPending && !byType.isError && rows.length === 0
	const showSignalEmpty = noDataAtAll && !(activeFilterCount === 0 && traces.status === "present")

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar} activeFilterCount={activeFilterCount}>
			{showSignalEmpty ? (
				<SignalEmptyState
					signal="traces"
					noun="errors"
					filtered={activeFilterCount > 0}
					onClearFilters={clearFilters}
					range={range}
					onWidenRange={() => setRange(WIDEST_RANGE)}
				/>
			) : (
				<div className="space-y-4 p-4">
					<ErrorsKpis summary={summary.data ?? null} pending={summary.isPending} />
					{scope.error ? (
						<ErrorState label="the project's services" error={scope.error} />
					) : byType.isPending ? (
						<ListSkeleton variant="card" rows={6} />
					) : byType.isError ? (
						<ErrorState label="errors" error={byType.error} onRetry={() => byType.refetch()} />
					) : rows.length === 0 ? (
						<EmptyState
							icon={<CircleWarningIcon />}
							title="No errors in this range"
							hint="Errors appear when spans arrive with an Error status. None did in the selected window."
						/>
					) : (
						<div
							className={cn(
								"space-y-2",
								byType.isPlaceholderData && "opacity-60 transition-opacity",
							)}
						>
							{rows.map((row) => (
								<ErrorTypeCard
									key={row.fingerprintHash}
									row={row}
									versions={versions.data?.get(row.fingerprintHash) ?? []}
									slices={slices.data?.get(row.fingerprintHash) ?? EMPTY_SLICES}
									traffic={traffic.data ?? EMPTY_TRAFFIC}
									versionsPending={versionsPending}
									spark={sparkData.data?.get(row.fingerprintHash) ?? []}
									sparkWindow={spark}
									filters={filters}
									bounds={timeWindow.bounds}
									scope={scope}
									query={query}
								/>
							))}
						</div>
					)}
				</div>
			)}
		</PageShell>
	)
}

/**
 * The four numbers the page leads with. All four come off one
 * `errorsSummaryQuery` row, so they reconcile: the rate is this window's errors
 * over this window's spans.
 */
function ErrorsKpis({ summary, pending }: { summary: CH.ErrorsSummaryOutput | null; pending: boolean }) {
	if (pending && !summary) {
		return (
			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				{[0, 1, 2, 3].map((i) => (
					<div key={i} className="h-[4.5rem] animate-pulse rounded-md border bg-muted/40" />
				))}
			</div>
		)
	}

	return (
		<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
			<KpiCard
				label="Total Errors"
				value={formatNumber(Math.round(summary?.totalErrors ?? 0))}
				hint="error spans in range"
				danger
			/>
			<KpiCard
				label="Error Rate"
				value={formatErrorRate(summary?.errorRate ?? 0)}
				hint={`of ${formatNumber(Math.round(summary?.totalSpans ?? 0))} spans`}
			/>
			<KpiCard
				label="Affected Services"
				value={formatNumber(Math.round(summary?.affectedServicesCount ?? 0))}
				hint="services reporting errors"
			/>
			<KpiCard
				label="Affected Traces"
				value={formatNumber(Math.round(summary?.affectedTracesCount ?? 0))}
				hint="traces containing an error"
			/>
		</div>
	)
}

function KpiCard({
	label,
	value,
	hint,
	danger,
}: {
	label: string
	value: string
	hint: string
	danger?: boolean
}) {
	return (
		<div className="rounded-md border bg-card px-3 py-2">
			<div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
				{label}
			</div>
			<div className={cn("text-lg font-semibold tabular-nums", danger && "text-destructive")}>
				{value}
			</div>
			<div className="truncate text-[10px] text-muted-foreground">{hint}</div>
		</div>
	)
}

/** The current view's params, plus the error span to focus when the trace has one. */
function traceLinkParams(query: URLSearchParams, errorSpanId: string): URLSearchParams {
	const params = new URLSearchParams(Object.fromEntries(query))
	if (errorSpanId) params.set("spanId", errorSpanId)
	return params
}

function ErrorTypeCard({
	row,
	versions,
	slices,
	traffic,
	versionsPending,
	spark,
	sparkWindow: window,
	filters,
	bounds,
	scope,
	query,
}: {
	row: ErrorTypeRow
	versions: ReadonlyArray<CH.ErrorVersionsOutput>
	slices: ReadonlyArray<ErrorSlice>
	traffic: ReadonlyArray<VersionTraffic>
	versionsPending: boolean
	spark: ReadonlyArray<SparkPoint>
	sparkWindow: SparkWindow
	filters: ErrorsFilters
	bounds: TimeBounds
	scope: ProjectScope
	query: URLSearchParams
}) {
	const [expanded, setExpanded] = useState(false)
	const traces = useLocalErrorTraces(expanded ? row.fingerprintHash : undefined, filters, bounds, scope)
	const panelId = `error-traces-${row.fingerprintHash}`
	const compared = useMemo(() => compareErrorVersions(slices, traffic), [slices, traffic])
	const introduction = versionsPending ? null : introducedIn(compared, traffic)

	return (
		<div className="rounded-md border bg-card">
			<button
				type="button"
				onClick={() => setExpanded((prev) => !prev)}
				aria-expanded={expanded}
				aria-controls={panelId}
				className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
			>
				<CircleWarningIcon className="size-4 shrink-0 text-destructive" />
				<span className="min-w-0 flex-1">
					<span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
						<span className="truncate text-sm font-medium">
							{row.errorLabel || "Unknown Error"}
						</span>
						{/* Names only; the affected-services number sits beside the count. */}
						{row.serviceNames.map((serviceName) => (
							<Badge
								key={serviceName}
								variant="outline"
								className="gap-1.5 font-mono text-[10px]"
							>
								<ServiceDot serviceName={serviceName} />
								{serviceName}
							</Badge>
						))}
						{row.serviceNames.length > 0 &&
						row.affectedServicesCount > row.serviceNames.length ? (
							<span className="shrink-0 text-xs text-muted-foreground">
								+{row.affectedServicesCount - row.serviceNames.length} more
							</span>
						) : null}
					</span>
					{row.sampleMessage ? (
						<span className="block truncate font-mono text-xs text-muted-foreground">
							{row.sampleMessage}
						</span>
					) : null}
					{introduction ? <IntroductionLine introduction={introduction} /> : null}
				</span>
				<span className="hidden shrink-0 sm:block">
					<OccurrenceSpark points={spark} window={window} />
				</span>
				<span className="shrink-0 text-right">
					<span className="block text-sm font-semibold tabular-nums text-destructive">
						{formatNumber(row.count)}
					</span>
					<span className="block text-[10px] text-muted-foreground">
						{row.affectedServicesCount === 1
							? "1 service"
							: `${formatNumber(row.affectedServicesCount)} services`}
					</span>
					<span className="block text-[10px] text-muted-foreground">
						last seen {formatRelativeTime(row.lastSeen)}
					</span>
				</span>
				<ChevronDownIcon
					className={cn(
						"size-4 shrink-0 text-muted-foreground transition-transform",
						expanded && "rotate-180",
					)}
				/>
			</button>

			{expanded ? (
				<div id={panelId} className="space-y-3 border-t px-4 py-3">
					<CompareVersions compared={compared} totals={versions} pending={versionsPending} />
					<ErrorSampleDetail row={row} bounds={bounds} query={query} />
					<div className="space-y-1">
						<h4 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
							Recent traces
						</h4>
						{traces.isPending ? (
							<div className="flex h-16 items-center justify-center">
								<Spinner className="size-4" />
							</div>
						) : traces.isError ? (
							<ErrorState
								label="traces"
								error={traces.error}
								onRetry={() => traces.refetch()}
							/>
						) : (traces.data ?? []).length === 0 ? (
							<p className="py-2 text-xs text-muted-foreground">
								No traces found for this error in the selected range.
							</p>
						) : (
							<ul className="divide-y">
								{(traces.data ?? []).map((trace) => (
									<li key={trace.traceId}>
										<a
											href={hrefFor(
												`/traces/${encodeURIComponent(trace.traceId)}`,
												traceLinkParams(query, trace.errorSpanId),
											)}
											className="flex w-full items-center gap-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
										>
											<span className="min-w-0 flex-1 truncate font-mono">
												{trace.errorSpanName || trace.rootSpanName || trace.traceId}
												{trace.errorServiceName ? (
													<span className="ml-2 text-muted-foreground/70">
														{trace.errorServiceName}
													</span>
												) : null}
											</span>
											<span className="shrink-0 tabular-nums">
												{trace.spanCount} spans
											</span>
											<span className="shrink-0 tabular-nums">
												{formatDuration(trace.durationMicros / 1000)}
											</span>
											<span className="shrink-0 tabular-nums">
												{formatRelativeTime(trace.startTime)}
											</span>
										</a>
									</li>
								))}
							</ul>
						)}
					</div>
				</div>
			) : null}
		</div>
	)
}

/**
 * When this error fired, across the selected range. A count and a "last seen"
 * say nothing about the shape between them; forty buckets of one page-wide
 * query tell a one-minute burst from a steady trickle. Empty buckets are filled
 * before drawing — `StatSparkline` has no time axis, so without them the gaps
 * (the most informative part) disappear.
 */
function OccurrenceSpark({ points, window }: { points: ReadonlyArray<SparkPoint>; window: SparkWindow }) {
	const counts = useMemo(() => denseCounts(points, window), [points, window])
	const total = counts.reduce((sum, value) => sum + value, 0)

	// A row of pure zeroes would read as "no errors" while meaning "no data".
	if (total === 0) return <span className="block h-6 w-24" />

	return (
		<StatSparkline
			data={counts.map((value) => ({ value }))}
			color="var(--destructive)"
			className="h-6 w-24"
		/>
	)
}

const REASON_TEXT = {
	unversioned: "no version set",
	"no-traffic": "no traffic recorded for this version",
	oldest: "oldest version in this window",
	"low-traffic": "too little traffic to compare",
} satisfies Record<NotComparedReason, string>

/**
 * The card subtitle: where this error arrived, and whether that is a claim
 * (it never fired on the version this one replaced) or only an observation
 * (nothing earlier in the window to check against).
 */
function IntroductionLine({ introduction }: { introduction: Introduction }) {
	if (introduction.kind === "introduced") {
		return (
			<span
				className="block truncate text-[10px] text-muted-foreground"
				title={`Fired on ${introduction.version} and never on ${introduction.baselineVersion}, the version it replaced on the same service and environment, inside the selected window.`}
			>
				Introduced in <span className="font-medium text-foreground">{introduction.version}</span>
				{" · "}not seen on {introduction.baselineVersion}
			</span>
		)
	}
	const why =
		introduction.reason === "present-before"
			? `also seen on ${introduction.baselineVersion ?? "the version before it"}`
			: introduction.reason === "low-traffic" && introduction.baselineVersion
				? `too little traffic on it or ${introduction.baselineVersion} to compare`
				: introduction.reason === "oldest"
					? "oldest version in this window, nothing earlier to compare"
					: REASON_TEXT[introduction.reason]
	return (
		<span
			className="block truncate text-[10px] text-muted-foreground"
			title="Earliest version this error fired on inside the selected window. Not called an introduction: nothing earlier could be compared — widen the range to look further back."
		>
			First seen on {introduction.version} · {why}
		</span>
	)
}

/**
 * This fingerprint's occurrences per build, each compared against the version
 * it replaced on the same service and environment — the hosted release rule —
 * as a rate over each version's own traffic. Rows that could not be compared
 * say why, and when none could the table says so rather than leaving a column
 * of blanks. Any count the per-slice result misses (it is row-limited) is one
 * closing row, so the table still adds up to the merged per-version total.
 */
function CompareVersions({
	compared,
	totals,
	pending,
}: {
	compared: ReadonlyArray<ComparedVersion>
	totals: ReadonlyArray<CH.ErrorVersionsOutput>
	pending: boolean
}) {
	if (pending) return <div className="h-12 animate-pulse rounded-md bg-muted/40" />

	const total = totals.reduce((sum, row) => sum + row.count, 0)
	const attributed = compared.reduce((sum, row) => sum + row.count, 0)
	const unattributed = Math.max(total - attributed, 0)
	// Nothing to compare at all: no slice, and the merged split is one blank version.
	if (compared.length === 0 && (totals.length === 0 || (totals.length === 1 && !totals[0].serviceVersion)))
		return null

	const multiplePairs =
		new Set(compared.map((row) => `${row.serviceName}\u0000${row.environment}`)).size > 1
	const denominator = Math.max(total, attributed)

	return (
		<div className="space-y-1">
			<h4 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
				Compare versions
				<span className="ml-1.5 normal-case tracking-normal">
					· each against the version it replaced
				</span>
			</h4>
			<ul className="divide-y rounded-md border">
				{versionsByRecency(compared).map((row) => (
					<li
						key={`${row.serviceName}\u0000${row.environment}\u0000${row.serviceVersion}`}
						className="flex items-center gap-3 px-2 py-1.5 text-xs"
					>
						<span className="min-w-0 flex-1 truncate">
							<span
								className={cn(
									"font-mono",
									row.serviceVersion ? "text-foreground" : "text-muted-foreground italic",
								)}
							>
								{row.serviceVersion || UNVERSIONED}
							</span>
							{multiplePairs ? (
								<span className="ml-1.5 text-muted-foreground">
									{row.serviceName} · {row.environment}
								</span>
							) : null}
						</span>
						<VersionComparisonCell row={row} />
						<span className="shrink-0 tabular-nums text-muted-foreground">
							{denominator > 0 ? formatErrorRate(row.count / denominator) : "—"}
						</span>
						<span className="w-14 shrink-0 text-right tabular-nums font-medium text-destructive">
							{formatNumber(row.count)}
						</span>
						<span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
							{formatRelativeTime(row.lastSeen)}
						</span>
					</li>
				))}
				{unattributed > 0 ? (
					<li className="flex items-center gap-3 px-2 py-1.5 text-xs text-muted-foreground">
						<span
							className="min-w-0 flex-1 truncate italic"
							title="Occurrences the per-service breakdown did not return (its result is row-limited), so they have no version to order."
						>
							no version data
						</span>
						<span className="shrink-0 italic">not compared</span>
						<span className="shrink-0 tabular-nums">
							{formatErrorRate(unattributed / denominator)}
						</span>
						<span className="w-14 shrink-0 text-right tabular-nums font-medium text-destructive">
							{formatNumber(unattributed)}
						</span>
						<span className="w-20 shrink-0" />
					</li>
				) : null}
			</ul>
			{nothingCompared(compared) ? (
				<p className="text-[10px] text-muted-foreground">{nothingComparedText(compared)}</p>
			) : null}
		</div>
	)
}

function nothingComparedText(compared: ReadonlyArray<ComparedVersion>): string {
	const reasons = new Set(
		compared.map((row) => (row.comparison.kind === "not-compared" ? row.comparison.reason : null)),
	)
	if (compared.length === 0 || (reasons.has("unversioned") && reasons.size === 1))
		return "Nothing compared: no versioned traffic for this error in the selected window."
	if (reasons.size === 1 && reasons.has("oldest"))
		return "Nothing compared: each version here is the oldest of its service in this window — widen the range to compare against what came before."
	return "Nothing compared: no version here has a predecessor on the same service and environment with enough traffic in this window."
}

/** "new", "×3.2", "≈" against the predecessor, or why there is no comparison. */
function VersionComparisonCell({ row }: { row: ComparedVersion }) {
	const { comparison } = row
	if (comparison.kind === "not-compared") {
		return (
			<span className="shrink-0 italic text-muted-foreground" title={REASON_TEXT[comparison.reason]}>
				{comparison.reason === "oldest"
					? "oldest"
					: comparison.reason === "low-traffic"
						? "low traffic"
						: "not compared"}
			</span>
		)
	}
	const { baseline, verdict, ratio, errorRate } = comparison
	const title = `${formatRate(errorRate)} vs ${formatRate(baseline.errorRate)} on ${baseline.version} (${formatNumber(baseline.errorCount)} in ${formatNumber(baseline.spanCount)} spans)`
	const label =
		verdict === "new"
			? `new vs ${baseline.version}`
			: verdict === "similar"
				? `≈ ${baseline.version}`
				: `×${formatRatio(ratio ?? 0)} vs ${baseline.version}`
	return (
		<span
			className={cn(
				"max-w-40 shrink-0 truncate tabular-nums",
				verdict === "new" || verdict === "more"
					? "font-medium text-destructive"
					: "text-muted-foreground",
			)}
			title={title}
		>
			{label}
		</span>
	)
}

const formatRatio = (ratio: number) => (ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1))

/** Occurrences per thousand spans — readable at the rates one fingerprint reaches. */
const formatRate = (rate: number) => `${(rate * 1000).toFixed(rate * 1000 >= 10 ? 0 : 1)}/1k spans`

/** The newest occurrence's stack, then the browser sessions it was hit in. */
function ErrorSampleDetail({
	row,
	bounds,
	query,
}: {
	row: ErrorTypeRow
	bounds: TimeBounds
	query: URLSearchParams
}) {
	const sample = useLocalErrorSampleStack(row.fingerprintHash, bounds)
	return (
		<>
			<SampleStack
				data={sample.data ?? null}
				isPending={sample.isPending}
				fallbackLabel={row.errorLabel}
				fallbackMessage={row.sampleMessage}
			/>
			{/* Mounted only once the stack has resolved: the needle comes off it,
			    and running without one drops the half of the query that finds
			    browser errors. */}
			{sample.isPending ? null : (
				<SessionsWithError
					fingerprintHash={row.fingerprintHash}
					messageMatch={
						sample.data?.exceptionMessage || sample.data?.exceptionType || row.sampleMessage
					}
					bounds={bounds}
					query={query}
				/>
			)}
		</>
	)
}

/**
 * The newest occurrence's exception, rendered through the shared stack-trace
 * renderer. The list row's label and message are the fallback header for a
 * stack the exporter sent without one.
 */
function SampleStack({
	data,
	isPending,
	fallbackLabel,
	fallbackMessage,
}: {
	data: CH.ErrorSampleStackOutput | null
	isPending: boolean
	fallbackLabel: string
	fallbackMessage: string
}) {
	if (isPending) {
		return <div className="h-12 animate-pulse rounded-md bg-muted/40" />
	}
	if (!data) return null

	const stack = data.exceptionStacktrace
	const type = data.exceptionType || fallbackLabel
	const message = data.exceptionMessage || fallbackMessage

	if (!stack && !type && !message && !data.topFrame) return null

	// An upstream that answers with its own error envelope puts a whole JSON
	// document where the header expects a sentence; give it the payload
	// treatment and keep the class alone in the header.
	const messageLanguage = message ? detectLanguage(message) : "text"
	const structuredMessage = messageLanguage !== "text"

	return (
		<div className="space-y-1">
			<h4 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
				Latest occurrence
			</h4>
			{structuredMessage ? (
				<CodeBlock
					value={message}
					language={messageLanguage}
					label={type || "message"}
					copyLabel="error message"
					collapseAfter={8}
					compact
				/>
			) : null}
			<StackTrace
				stack={stack}
				exceptionType={type}
				exceptionMessage={structuredMessage ? "" : message}
			/>
			{/* The ingest-computed top frame is what the fingerprint groups on; it
			    is the whole location when the exporter sent no stack at all. */}
			{!stack && data.topFrame ? (
				<p className="truncate font-mono text-[10px] text-muted-foreground" title={data.topFrame}>
					{data.topFrame}
				</p>
			) : null}
		</div>
	)
}

/**
 * The browser sessions this error was hit in. Each row links into the session
 * at the matching event (`?jump=<seq>`), so the replay opens on the moment.
 * Renders nothing for the common case of a backend error no browser saw.
 */
function SessionsWithError({
	fingerprintHash,
	messageMatch,
	bounds,
	query,
}: {
	fingerprintHash: string
	messageMatch: string | undefined
	bounds: TimeBounds
	query: URLSearchParams
}) {
	// The page's own project lookup, shared through the query cache.
	const scope = useNamespaceServices(bounds)
	const sessions = useLocalErrorSessions(fingerprintHash, messageMatch, bounds, scope)
	const rows = sessions.data ?? []
	if (sessions.isPending || rows.length === 0) return null

	const sessionHref = (sessionId: string, jumpSeq: number) => {
		const params = new URLSearchParams()
		const range = query.get("range")
		if (range) params.set("range", range)
		params.set("jump", String(jumpSeq))
		return hrefFor(`/sessions/${encodeURIComponent(sessionId)}`, params)
	}

	return (
		<div className="space-y-1">
			<h4 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
				Sessions with this error
			</h4>
			<ul className="divide-y rounded-md border">
				{rows.map((session) => (
					<li key={session.sessionId}>
						<a
							href={sessionHref(session.sessionId, session.jumpSeq)}
							className="flex items-center gap-3 px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
						>
							<EyeIcon className="size-3.5 shrink-0" />
							<span className="min-w-0 flex-1 truncate font-mono">
								{session.browserName || session.sessionId}
								{session.osName ? (
									<span className="ml-1.5 text-muted-foreground">{session.osName}</span>
								) : null}
							</span>
							<span className="shrink-0 tabular-nums">
								{session.matchCount === 1 ? "1 hit" : `${session.matchCount} hits`}
							</span>
							<span className="shrink-0 tabular-nums">
								{formatNumber(session.errorCount)} errors
							</span>
							<span className="w-20 shrink-0 text-right tabular-nums">
								{formatRelativeTime(session.startTime)}
							</span>
						</a>
					</li>
				))}
			</ul>
		</div>
	)
}
