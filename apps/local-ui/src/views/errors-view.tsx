import { useMemo, useState } from "react"
import { CircleWarningIcon, ChevronDownIcon, EyeIcon } from "@maple/ui/components/icons"
import { Badge } from "@maple/ui/components/ui/badge"
import { StatSparkline } from "@maple/ui/components/charts/sparkline/stat-sparkline"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { formatDuration, formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import {
	FilterSection,
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
	useLocalErrorVersions,
	useLocalErrorsByType,
	useLocalErrorsSpark,
	useLocalErrorsFacets,
	useLocalErrorsSummary,
	type ErrorsFilters,
} from "../hooks/use-local-errors"
import { introducedVersion, versionsByRecency } from "../lib/error-versions"
import { denseCounts, sparkWindow, type SparkPoint } from "../lib/error-spark"
import { useQueryParams } from "../lib/router"
import { DEFAULT_RANGE, formatRelativeTime } from "../lib/time"
import { PageShell } from "../components/page-shell"
import { RefreshButton, TimeRangeSelect, Toolbar, ToolbarStats } from "../components/toolbar"
import { EmptyState, ErrorState, ListSkeleton } from "../components/view-states"
import { StackTrace } from "../components/stack-trace"

interface ErrorsViewProps {
	onSelectTrace: (traceId: string) => void
}

/** Columns in the "Errors by Type" table — the colSpan an expanded row has to cover. */
const TABLE_COLUMNS = 8

/** What a `ServiceVersion` of `''` reads as: the exporter never set one. */
const UNVERSIONED = "unversioned"

export function ErrorsView({ onSelectTrace }: ErrorsViewProps) {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || DEFAULT_RANGE
	const service = query.get("service") || undefined
	const env = query.get("env") || undefined
	const errorType = query.get("type") || undefined
	const version = query.get("version") || undefined
	const rootOnly = query.get("root") === "1"

	const filters: ErrorsFilters = { service, env, errorType, version, rootOnly, range }
	const summary = useLocalErrorsSummary(filters)
	const byType = useLocalErrorsByType(filters)
	const facets = useLocalErrorsFacets(filters)
	const hasActiveFilters = !!service || !!env || !!errorType || !!version || rootOnly

	const sidebar = (
		<FilterSidebarFrame className="w-56 shrink-0 px-4" waiting={facets.isFetching}>
			<FilterSidebarHeader
				canClear={hasActiveFilters}
				onClear={() => setParams({ service: null, env: null, type: null, version: null, root: null })}
			/>
			<FilterSidebarBody>
				{/*
				 * The hosted sidebar's box, with the hosted spelling: checked means
				 * "count an error wherever it happened", unchecked means "only the
				 * span that ended the request". Local's default is the checked one —
				 * a browser `captureException` and a DB driver's throw are both
				 * non-root, and on a dev machine those are most of what there is to
				 * look at. So `root=1` names the exception, which is also what keeps
				 * every link that already carried it pointing at the same page.
				 */}
				<SingleCheckboxFilter
					title="All span errors"
					checked={!rootOnly}
					onChange={(checked) => setParams({ root: checked ? null : "1" })}
				/>
				<SearchableFilterSection
					title="Service"
					options={facets.data?.services ?? []}
					selected={service ? [service] : []}
					onChange={(vals) => setParams({ service: vals.at(-1) ?? null })}
					colorMap={serviceColorMap(facets.data?.services ?? [])}
				/>
				<FilterSection
					title="Environment"
					options={facets.data?.environments ?? []}
					selected={env ? [env] : []}
					onChange={(vals) => setParams({ env: vals.at(-1) ?? null })}
				/>
				<SearchableFilterSection
					title="Error Type"
					options={facets.data?.errorTypes ?? []}
					selected={errorType ? [errorType] : []}
					onChange={(vals) => setParams({ type: vals.at(-1) ?? null })}
				/>
				{/* Which deploy the error was seen on — the fastest way to tell a
				    regression from something that was always broken. Blank versions
				    are absent by construction: `errorsFacetsQuery` drops them, because
				    a facet you cannot act on is noise. */}
				<SearchableFilterSection
					title="Version"
					options={facets.data?.versions ?? []}
					selected={version ? [version] : []}
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
			<ToolbarStats>
				<RefreshButton />
				<TimeRangeSelect value={range} onChange={(next) => setParams({ range: next })} />
			</ToolbarStats>
		</Toolbar>
	)

	const rows = byType.data ?? []
	// One query for the whole page. Built off the rendered rows so it re-runs
	// when the list does, and skipped entirely while the list is still empty.
	const fingerprints = rows.map((row) => row.fingerprintHash)
	const versions = useLocalErrorVersions(fingerprints, filters)
	const spark = useLocalErrorsSpark(fingerprints, filters)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar}>
			<div className="space-y-4 p-4">
				<ErrorsKpis summary={summary.data ?? null} pending={summary.isPending} />

				<section className="space-y-2">
					<h3 className="text-sm font-medium">Errors by Type</h3>
					{byType.isPending ? (
						<ListSkeleton variant="card" rows={6} />
					) : byType.isError ? (
						<ErrorState label="errors" error={byType.error} onRetry={() => byType.refetch()} />
					) : rows.length === 0 ? (
						<EmptyState
							icon={<CircleWarningIcon />}
							title={hasActiveFilters ? "No matching errors" : "No errors recorded"}
							hint={
								hasActiveFilters
									? "Try widening the time range or clearing filters."
									: "Errors appear when spans arrive with an Error status."
							}
						/>
					) : (
						<div className="overflow-hidden rounded-md border bg-card">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead className="w-8" />
										<TableHead>Error Type</TableHead>
										<TableHead className="text-right">Count</TableHead>
										<TableHead className="w-28">Trend</TableHead>
										<TableHead className="text-right">Affected Services</TableHead>
										<TableHead className="text-right">First Seen</TableHead>
										<TableHead className="text-right">Last Seen</TableHead>
										<TableHead className="w-8" />
									</TableRow>
								</TableHeader>
								<TableBody>
									{rows.map((row) => (
										<ErrorTypeRow
											key={row.fingerprintHash}
											row={row}
											versions={versions.data?.get(row.fingerprintHash) ?? []}
											spark={spark.data?.get(row.fingerprintHash) ?? []}
											range={range}
											filters={filters}
											onSelectTrace={onSelectTrace}
										/>
									))}
								</TableBody>
							</Table>
						</div>
					)}
				</section>
			</div>
		</PageShell>
	)
}

/**
 * The four numbers the hosted page leads with.
 *
 * All four come off one `errorsSummaryQuery` row, which is what keeps them
 * reconcilable: the rate is this window's errors over this window's spans, not
 * two independently-scoped counts divided in the browser.
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

function ErrorTypeRow({
	row,
	versions,
	spark,
	range,
	filters,
	onSelectTrace,
}: {
	row: CH.ErrorsByTypeOutput
	versions: ReadonlyArray<CH.ErrorVersionsOutput>
	spark: ReadonlyArray<SparkPoint>
	range: string
	filters: ErrorsFilters
	onSelectTrace: (traceId: string) => void
}) {
	const [expanded, setExpanded] = useState(false)
	const toggle = () => setExpanded((prev) => !prev)
	const introduced = introducedVersion(versions)

	return (
		<>
			<TableRow className={cn(expanded && "border-b-0 bg-accent/30")}>
				<TableCell className="pr-0">
					<CircleWarningIcon className="size-4 text-destructive" />
				</TableCell>
				<TableCell className="max-w-0">
					<button
						type="button"
						onClick={toggle}
						aria-expanded={expanded}
						className="block w-full text-left"
					>
						<span className="block truncate text-sm font-medium text-primary underline-offset-2 hover:underline">
							{row.errorLabel || "Unknown Error"}
						</span>
						{row.sampleMessage ? (
							<span className="block truncate font-mono text-xs text-muted-foreground">
								{row.sampleMessage}
							</span>
						) : null}
						{introduced ? (
							<span
								className="block truncate text-[10px] text-muted-foreground"
								title="Oldest version this error was seen on inside the selected time range — widen the range to look further back."
							>
								Introduced in {introduced}
							</span>
						) : null}
					</button>
				</TableCell>
				<TableCell className="text-right">
					<Badge variant="error" className="tabular-nums">
						{formatNumber(row.count)}
					</Badge>
				</TableCell>
				<TableCell>
					<OccurrenceSpark points={spark} range={range} />
				</TableCell>
				<TableCell className="text-right tabular-nums">
					{formatNumber(row.affectedServicesCount)}
				</TableCell>
				<TableCell className="whitespace-nowrap text-right text-muted-foreground">
					{formatRelativeTime(row.firstSeen)}
				</TableCell>
				<TableCell className="whitespace-nowrap text-right text-muted-foreground">
					{formatRelativeTime(row.lastSeen)}
				</TableCell>
				<TableCell className="pl-0 text-right">
					<button
						type="button"
						onClick={toggle}
						aria-expanded={expanded}
						aria-label={expanded ? "Collapse error" : "Expand error"}
						className="text-muted-foreground transition-colors hover:text-foreground"
					>
						<ChevronDownIcon
							className={cn("size-4 transition-transform", expanded && "rotate-180")}
						/>
					</button>
				</TableCell>
			</TableRow>

			{expanded ? (
				<TableRow className="bg-accent/30 hover:bg-accent/30">
					<TableCell colSpan={TABLE_COLUMNS} className="px-4 py-3">
						<ErrorTypeDetail
							row={row}
							versions={versions}
							filters={filters}
							onSelectTrace={onSelectTrace}
						/>
					</TableCell>
				</TableRow>
			) : null}
		</>
	)
}

function ErrorTypeDetail({
	row,
	versions,
	filters,
	onSelectTrace,
}: {
	row: CH.ErrorsByTypeOutput
	versions: ReadonlyArray<CH.ErrorVersionsOutput>
	filters: ErrorsFilters
	onSelectTrace: (traceId: string) => void
}) {
	const traces = useLocalErrorTraces(row.fingerprintHash, filters)
	const sample = useLocalErrorSampleStack(row.fingerprintHash, filters)

	return (
		<div className="space-y-3">
			<CompareVersions rows={versions} />
			<SampleStack
				data={sample.data ?? null}
				isPending={sample.isPending}
				fallbackLabel={row.errorLabel}
				fallbackMessage={row.sampleMessage}
			/>
			{/* Mounted only once the stack has resolved: the needle comes off it, and
			    running without one drops the half of the query that finds browser
			    errors. A conditional mount rather than a conditional hook. */}
			{sample.isPending ? null : (
				<SessionsWithError
					fingerprintHash={row.fingerprintHash}
					messageMatch={
						sample.data?.exceptionMessage || sample.data?.exceptionType || row.sampleMessage
					}
					filters={filters}
				/>
			)}
			{traces.isPending ? (
				<div className="flex h-16 items-center justify-center">
					<Spinner className="size-4" />
				</div>
			) : traces.isError ? (
				<p className="py-2 text-xs text-destructive">Couldn’t load traces: {String(traces.error)}</p>
			) : (traces.data ?? []).length === 0 ? (
				<p className="py-2 text-xs text-muted-foreground">
					No traces found for this error in the selected range.
				</p>
			) : (
				<ul className="divide-y">
					{(traces.data ?? []).map((trace) => (
						<li key={trace.traceId}>
							<button
								type="button"
								onClick={() => onSelectTrace(trace.traceId)}
								className="flex w-full items-center gap-3 py-2 text-left text-xs transition-colors hover:text-foreground text-muted-foreground"
							>
								<span className="min-w-0 flex-1 truncate font-mono">
									{trace.rootSpanName || trace.traceId}
								</span>
								<span className="shrink-0 tabular-nums">{trace.spanCount} spans</span>
								<span className="shrink-0 tabular-nums">
									{formatDuration(trace.durationMicros / 1000)}
								</span>
								<span className="shrink-0 tabular-nums">
									{formatRelativeTime(trace.startTime.slice(0, 19))}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	)
}

/**
 * The browser sessions this error was hit in.
 *
 * The traces list below answers "which requests broke". For an error a person
 * hit in a browser that is the wrong unit — the answer is the recording: what
 * they were doing in the ten seconds before the throw, and what the page looked
 * like after it. Each row links into the session at the event that matched, so
 * the replay opens on the moment rather than at 00:00.
 *
 * The `?jump=` param is emitted and nothing here interprets it — resolving a
 * seq to a player position is the session page's job, and this view has no
 * business knowing how.
 */
function SessionsWithError({
	fingerprintHash,
	messageMatch,
	filters,
}: {
	fingerprintHash: string
	messageMatch: string | undefined
	filters: ErrorsFilters
}) {
	const sessions = useLocalErrorSessions(fingerprintHash, messageMatch, filters)
	const rows = sessions.data ?? []

	// Nothing to say is said by saying nothing: a backend error nobody's browser
	// ever saw is the common case, and an empty panel on every one of them is
	// noise on the row that matters.
	if (sessions.isPending || rows.length === 0) return null

	const sessionHref = (sessionId: string, jumpSeq: number) => {
		const params = new URLSearchParams()
		if (filters.range) params.set("range", filters.range)
		params.set("jump", String(jumpSeq))
		return `#/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`
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
							{/* The session's total error count, which is the fingerprint's
							    count plus whatever else went wrong in the same visit. */}
							<span className="shrink-0 tabular-nums">
								{formatNumber(session.errorCount)} errors
							</span>
							<span className="w-20 shrink-0 text-right tabular-nums">
								{formatRelativeTime(session.startTime.slice(0, 19))}
							</span>
						</a>
					</li>
				))}
			</ul>
		</div>
	)
}

/**
 * When this error fired, across the selected range.
 *
 * A count and a "last seen" describe two instants and say nothing about the
 * shape between them: 412 occurrences in one minute of an outage and 412 spread
 * evenly over a week are the same two numbers and completely different
 * problems. Forty buckets of one query — `errorsSparkQuery` runs once for the
 * whole page, not once per row — is enough to tell those apart at a glance.
 *
 * The empty buckets are filled in before drawing. `StatSparkline` plots a
 * sequence with no time axis, so without them an error that fired twice a week
 * apart draws the same flat line as one firing steadily, and the gap — the most
 * informative thing on the chart — disappears.
 */
function OccurrenceSpark({ points, range }: { points: ReadonlyArray<SparkPoint>; range: string }) {
	const counts = useMemo(() => denseCounts(points, sparkWindow(range)), [points, range])
	const total = counts.reduce((sum, value) => sum + value, 0)

	// `StatSparkline` draws nothing below two points, and a row of pure zeroes is
	// a straight line that says "no data" while looking like "no errors". Both
	// cases leave the cell empty rather than drawing something untrue.
	if (total === 0) return null

	return (
		<StatSparkline
			data={counts.map((value) => ({ value }))}
			color="var(--destructive)"
			className="h-6 w-24"
		/>
	)
}

/**
 * This fingerprint's occurrences, split by the build they ran on.
 *
 * The single most useful thing to know about an error is whether it is new, and
 * a row per version answers it at a glance: all of the count on the newest build
 * is a regression that shipped with it, and an even spread across six builds is
 * something that was always there. Rows come from the same batched
 * `errorVersionsQuery` the list's "Introduced in" line reads, so opening a row
 * costs nothing extra.
 *
 * Nothing is drawn when there is one version and it is blank — that is every
 * exporter that never set `service.version`, and a one-row table saying
 * "unversioned" is the whole page's worth of chrome for no information.
 */
function CompareVersions({ rows }: { rows: ReadonlyArray<CH.ErrorVersionsOutput> }) {
	if (rows.length === 0) return null
	if (rows.length === 1 && !rows[0].serviceVersion) return null

	const total = rows.reduce((sum, row) => sum + row.count, 0)

	return (
		<div className="space-y-1">
			<h4 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
				Compare versions
			</h4>
			<ul className="divide-y rounded-md border">
				{versionsByRecency(rows).map((row) => (
					<li
						key={row.serviceVersion || UNVERSIONED}
						className="flex items-center gap-3 px-2 py-1.5 text-xs"
					>
						<span
							className={cn(
								"min-w-0 flex-1 truncate font-mono",
								row.serviceVersion ? "text-foreground" : "text-muted-foreground italic",
							)}
						>
							{row.serviceVersion || UNVERSIONED}
						</span>
						<span className="shrink-0 tabular-nums text-muted-foreground">
							{total > 0 ? formatErrorRate(row.count / total) : "—"}
						</span>
						<span className="w-14 shrink-0 text-right tabular-nums font-medium text-destructive">
							{formatNumber(row.count)}
						</span>
						<span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
							{formatRelativeTime(row.lastSeen)}
						</span>
					</li>
				))}
			</ul>
		</div>
	)
}

/**
 * The newest occurrence's exception, under the fingerprint it belongs to.
 *
 * `error_events` has held `ExceptionStacktrace` and `TopFrame` since the table
 * existed — materialized from the span's `exception` event — and no Local view
 * read either, so an error in the list was an `ErrorLabel` and a truncated
 * `StatusMessage`. Read: the line that threw.
 *
 * The list row's own label and message are the fallback header, for a stack the
 * exporter sent without one (a Go or Rust runtime, or a browser stack the SDK
 * trimmed).
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

	// Nothing at all to draw: no stack, no class, no message. The traces list
	// below is still the answer, so this section just stands down.
	if (!stack && !type && !message && !data.topFrame) return null

	return (
		<div className="space-y-1">
			<h4 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
				Latest occurrence
			</h4>
			<StackTrace stack={stack} exceptionType={type} exceptionMessage={message} />
			{/* The ingest-computed top frame is what the fingerprint is grouped on. It
			    is redundant beside a full stack, and it is the whole location when
			    the exporter sent no stack at all. */}
			{!stack && data.topFrame ? (
				<p className="truncate font-mono text-[10px] text-muted-foreground" title={data.topFrame}>
					{data.topFrame}
				</p>
			) : null}
		</div>
	)
}
