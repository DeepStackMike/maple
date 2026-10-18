import {
	useCallback,
	useEffectEvent,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
	type RefObject,
} from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { LogPattern } from "@maple/query-engine/observability"
import { ActiveFilterChips, type ActiveFilterChip } from "@maple/ui/components/filters/active-filter-chips"
import { LogAttributeChip } from "@maple/ui/components/logs/log-attribute-chip"
import { severityLabel } from "@maple/ui/components/logs/severity-badge"
import { stripAnsi } from "@maple/ui/components/logs/strip-ansi"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { Badge } from "@maple/ui/components/ui/badge"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { IconButton } from "@maple/ui/components/ui/icon-button"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { CopyIcon, LinkIcon, MaximizeIcon, PulseIcon } from "@maple/ui/components/icons"
import { useCopy } from "@maple/ui/hooks/use-copy"
import { useMountEffect } from "@maple/ui/hooks/use-mount-effect"
import { countLabel, formatNumber } from "@maple/ui/lib/format"
import { pickImportantAttributes } from "@maple/ui/lib/log-attributes"
import { getSeverityColor } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import {
	FilterSection,
	SearchableFilterSection,
	serviceColorMap,
} from "@maple/ui/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import {
	useLocalLogByKey,
	useLocalLogEnvironments,
	useLocalLogHistogram,
	useLocalLogs,
	useLocalLogSeverities,
	logHistogramBucketSeconds,
	type LogFilters,
} from "../hooks/use-local-logs"
import { useLocalLogPatterns } from "../hooks/use-local-log-patterns"
import { useLocalLogServices } from "../hooks/use-local-log-services"
import { useNamespaceServices } from "../hooks/use-namespace-services"
import { useRange } from "../hooks/use-range"
import { useTimeWindow } from "../hooks/use-time-window"
import { hrefFor, navigate, parseLocation, useQueryParams } from "../lib/router"
import {
	customRangeKey,
	formatUtcTitle,
	parseCustomRange,
	resolveRangeWindow,
	WIDEST_RANGE,
	type TimeBounds,
} from "../lib/time"
import {
	EMPTY_LOG_HISTOGRAM,
	orderBySeverity,
	severityColorMap,
	type LogHistogramBucket,
} from "../lib/log-histogram"
import {
	addLogAttributeFilter,
	ATTRS_PARAM,
	decodeLogAttributeFilter,
	logAttributeFilterLabel,
	removeLogAttributeFilter,
	type LogAttributeFilter,
} from "../lib/log-attribute-filters"
import { decodeLogKey, encodeLogKey, LOG_PARAM, logPermalink, matchesLogKey } from "../lib/log-context"
import {
	canLiveTail,
	liveTailState,
	nextTickMs,
	NOT_INSPECTING,
	parseRefreshSeconds,
	refreshParam,
	REFRESH_PARAM,
	type InspectInputs,
} from "../lib/log-live-tail"
import { logKey, type LocalLog } from "../lib/log-shape"
import { patternSearchTerm } from "../lib/log-patterns"
import type { ProjectScope } from "../lib/project-scope"
import { LogDetailSheet } from "../components/log-detail-sheet"
import { LogPatternsList } from "../components/log-patterns-list"
import { LogTime } from "../components/log-time"
import { LogsLiveControls } from "../components/logs-live-controls"
import { HighlightedText } from "../components/highlighted-text"
import { PageShell } from "../components/page-shell"
import { SignalEmptyState } from "../components/signal-empty-state"
import { EmptyLogVolumeStrip, LogSeverityHistogram } from "../components/log-severity-histogram"
import {
	Toolbar,
	ToolbarSearch,
	ToolbarStat,
	ToolbarStats,
	TimeRangeSelect,
	RefreshButton,
} from "../components/toolbar"
import { ErrorState, ListSkeleton } from "../components/view-states"
import { failedWithoutData } from "../lib/query"

const ROW_HEIGHT = 36
/** Chips shown beside the message; the rest are in the drawer. */
const VISIBLE_CHIPS = 3

type LogsMode = "list" | "patterns"

/** Wraps a mode's body in the shared page chrome; each mode supplies its own stat and freshness. */
type RenderPage = (props: {
	stat: ReactNode
	since: number
	/** Wraps the reload button in the live-tail controls; absent and it stands alone. */
	live?: LiveSlot
	children: ReactNode
}) => ReactNode

/** The live-tail controls, built around the page's reload button. */
type LiveSlot = (reloadButton: ReactNode) => ReactNode

/** Pointer and scroll, the two inspect causes only the stream itself can see. */
type StreamInspect = Pick<InspectInputs, "hovering" | "scrolledAway">

/**
 * Replace every value of one repeated query param, preserving the rest. Reads
 * the live hash (like `useQueryParams`'s setter) so two updates in one tick
 * never clobber each other.
 */
function setQueryList(key: string, values: ReadonlyArray<string>): void {
	const current = parseLocation(window.location.hash.replace(/^#/, ""))
	const next = new URLSearchParams(current.query)
	next.delete(key)
	for (const value of values) next.append(key, value)
	navigate(current.path, next, { replace: true })
}

export function LogsView() {
	const [query, setParams] = useQueryParams()
	const [range, setRange] = useRange()
	const timeWindow = useTimeWindow(range)
	const queryClient = useQueryClient()
	const mode: LogsMode = query.get("mode") === "patterns" ? "patterns" : "list"
	const attrsParam = query.getAll(ATTRS_PARAM)
	const attrsSignature = attrsParam.join("\n")
	// Identity-stable per value, so query keys and memoized rows hold still.
	const attrs = useMemo(() => (attrsSignature === "" ? [] : attrsSignature.split("\n")), [attrsSignature])
	const filters: LogFilters = useMemo(
		() => ({
			service: query.get("service") || undefined,
			severity: query.get("severity") || undefined,
			environment: query.get("env") || undefined,
			search: query.get("q") || undefined,
			attrs: attrs.length > 0 ? attrs : undefined,
		}),
		[query, attrs],
	)

	/**
	 * The range a histogram zoom was taken from, so "reset" can return to it.
	 *
	 * Clicking a column pins the page to that bucket as a custom range key
	 * (`custom_<from>_<to>`) — the same vocabulary the range picker writes, so the
	 * zoomed view is a shareable URL and the select names it. The preset it came
	 * from rides alongside in `unzoom`; picking any range explicitly drops it.
	 */
	const unzoomTo = query.get("unzoom")
	const zoomed = !!unzoomTo && parseCustomRange(range) !== null
	const selectRange = (next: string) => {
		setRange(next)
		setParams({ unzoom: null })
	}
	const zoomToBucket = (bucket: LogHistogramBucket) => {
		setParams({
			range: customRangeKey({ fromMs: bucket.startMs, toMs: bucket.endMs }),
			unzoom: zoomed && unzoomTo ? unzoomTo : range,
		})
	}

	// The header project, as its services: every query below waits for it.
	const scope = useNamespaceServices(timeWindow.bounds)
	const services = useLocalLogServices(filters, timeWindow.bounds, scope)
	const severities = useLocalLogSeverities(filters, timeWindow.bounds, scope)
	const environments = useLocalLogEnvironments(filters, timeWindow.bounds, scope)

	// Attribute filters: one `attrs` entry per value, applied to list, histogram and facets.
	const addAttributeFilter = useCallback(
		(filter: LogAttributeFilter) => setQueryList(ATTRS_PARAM, addLogAttributeFilter(attrs, filter)),
		[attrs],
	)

	// Live tail. The stream reports pointer and scroll; the open drawer is the URL's `log`.
	const refresh = parseRefreshSeconds(query.get(REFRESH_PARAM))
	const [streamInspect, setStreamInspect] = useState<StreamInspect>(NOT_INSPECTING)
	const reportStreamInspect = useCallback((patch: Partial<StreamInspect>) => {
		setStreamInspect((prev) => {
			const next = { ...prev, ...patch }
			return next.hovering === prev.hovering && next.scrolledAway === prev.scrolledAway ? prev : next
		})
	}, [])
	const inspect: InspectInputs =
		mode === "list" ? { ...streamInspect, detailOpen: query.get(LOG_PARAM) !== null } : NOT_INSPECTING
	const live = liveTailState(mode === "list" ? refresh : 0, range, inspect)
	const reload = useCallback(() => {
		// Same as the refresh button: re-anchor the window, or refetch when it is current.
		if (!timeWindow.advance())
			void queryClient.invalidateQueries({ queryKey: ["local"], refetchType: "active" })
	}, [timeWindow, queryClient])
	const tickMs = nextTickMs(live)
	const scrollRef = useRef<HTMLDivElement>(null)
	const jumpToLatest = () => {
		scrollRef.current?.scrollTo({ top: 0 })
		reportStreamInspect({ scrolledAway: false })
		reload()
	}

	const decodedAttrs = attrs.flatMap((entry) => {
		const filter = decodeLogAttributeFilter(entry)
		return filter ? [{ entry, filter }] : []
	})
	const activeFilterCount =
		[filters.service, filters.severity, filters.environment].filter(Boolean).length + decodedAttrs.length
	const clearFacets = () => {
		setParams({ service: null, severity: null, env: null })
		setQueryList(ATTRS_PARAM, [])
	}
	const clearFilters = () => {
		setParams({ service: null, severity: null, env: null, q: null })
		setQueryList(ATTRS_PARAM, [])
	}

	// One account of the query above the results; the attribute filters have no
	// sidebar section, so this is where they are seen and removed.
	const filterChips: ActiveFilterChip[] = [
		...(filters.severity
			? [
					{
						id: "severity",
						label: "Severity",
						values: [filters.severity],
						onRemove: () => setParams({ severity: null }),
					},
				]
			: []),
		...(filters.environment
			? [
					{
						id: "env",
						label: "Environment",
						values: [filters.environment],
						onRemove: () => setParams({ env: null }),
					},
				]
			: []),
		...(filters.service
			? [
					{
						id: "service",
						label: "Service",
						values: [filters.service],
						onRemove: () => setParams({ service: null }),
					},
				]
			: []),
		...decodedAttrs.map(({ entry, filter }) => ({
			id: `attrs:${entry}`,
			label: logAttributeFilterLabel(filter),
			values: [filter.value === "" ? '""' : filter.value],
			negated: filter.negated,
			onRemove: () => setQueryList(ATTRS_PARAM, removeLogAttributeFilter(attrs, entry)),
		})),
	]

	// Reading order, and a swatch per option in the spelling that option carries.
	// The chart above the list reads the same two helpers, which is what makes a
	// band and the row beside it the same colour and the same position.
	const severityOptions = useMemo(
		() => orderBySeverity((severities.data ?? []).map((o) => ({ name: o.name, count: o.count }))),
		[severities.data],
	)
	const severityColors = useMemo(
		() => severityColorMap(severityOptions.map((o) => o.name)),
		[severityOptions],
	)

	const sidebar = (
		<FilterSidebarFrame
			className="w-56 shrink-0 px-4"
			waiting={services.isFetching || severities.isFetching || environments.isFetching}
		>
			<FilterSidebarHeader canClear={activeFilterCount > 0} onClear={clearFacets} />
			<FilterSidebarBody>
				<FilterSection
					title="Severity"
					options={severityOptions}
					selected={filters.severity ? [filters.severity] : []}
					onChange={(vals) => setParams({ severity: vals.at(-1) ?? null })}
					colorMap={severityColors}
				/>
				<FilterSection
					title="Environment"
					options={environments.data ?? []}
					selected={filters.environment ? [filters.environment] : []}
					onChange={(vals) => setParams({ env: vals.at(-1) ?? null })}
				/>
				<SearchableFilterSection
					title="Service"
					options={services.data ?? []}
					selected={filters.service ? [filters.service] : []}
					onChange={(vals) => setParams({ service: vals.at(-1) ?? null })}
					colorMap={serviceColorMap(services.data ?? [])}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const renderPage: RenderPage = ({ stat, since, live: liveControls, children }) => {
		const reloadButton = <RefreshButton advance={timeWindow.advance} since={since} />
		return (
			<PageShell
				sidebar={sidebar}
				activeFilterCount={activeFilterCount}
				toolbar={
					<Toolbar>
						<ToggleGroup
							value={[mode]}
							onValueChange={(values) => {
								const next = values.find((value) => value !== mode)
								if (next === "list" || next === "patterns")
									setParams({ mode: next === "patterns" ? next : null })
							}}
							variant="outline"
							size="sm"
							aria-label="Logs view"
							className="shrink-0"
						>
							<ToggleGroupItem value="list">List</ToggleGroupItem>
							<ToggleGroupItem value="patterns">Patterns</ToggleGroupItem>
						</ToggleGroup>
						<ToolbarSearch
							query={filters.search ?? ""}
							onSearch={(value) => setParams({ q: value ?? null })}
							placeholder="Search log bodies…"
							className="min-w-48 flex-1"
						/>
						<ToolbarStats className="shrink-0">
							{stat}
							{liveControls ? liveControls(reloadButton) : reloadButton}
							<TimeRangeSelect value={range} onChange={selectRange} />
						</ToolbarStats>
					</Toolbar>
				}
			>
				<div className="flex h-full min-h-0 flex-col">
					{filterChips.length > 0 ? (
						<ActiveFilterChips
							chips={filterChips}
							onClearAll={clearFacets}
							className="mb-0 shrink-0 border-b px-4 py-2"
						/>
					) : null}
					<div className="min-h-0 flex-1">{children}</div>
				</div>
			</PageShell>
		)
	}

	const emptyState = (
		<SignalEmptyState
			signal="logs"
			filtered={activeFilterCount > 0 || !!filters.search}
			onClearFilters={clearFilters}
			range={range}
			onWidenRange={() => selectRange(WIDEST_RANGE)}
		/>
	)

	if (scope.error) {
		return renderPage({
			stat: null,
			since: 0,
			children: <ErrorState label="the project's services" error={scope.error} />,
		})
	}

	// Remounted per cadence, so a hold (no tick) or a new cadence restarts the clock.
	const ticker =
		tickMs === null ? null : <LiveTailTicker key={tickMs} intervalMs={tickMs} onTick={reload} />

	// Each mode is its own component so only the active mode's queries run:
	// chDB serves one query at a time.
	const page =
		mode === "patterns" ? (
			<LogPatternsMode
				filters={filters}
				bounds={timeWindow.bounds}
				scope={scope}
				renderPage={renderPage}
				emptyState={emptyState}
				onSelect={(pattern) =>
					setParams({ mode: null, q: patternSearchTerm(pattern.template) || filters.search })
				}
			/>
		) : (
			<LogListMode
				filters={filters}
				bounds={timeWindow.bounds}
				anchorMs={timeWindow.anchorMs}
				range={range}
				scope={scope}
				renderPage={renderPage}
				emptyState={emptyState}
				zoomedFrom={zoomed ? unzoomTo : null}
				onZoomToBucket={zoomToBucket}
				onUnzoom={selectRange}
				openToken={query.get(LOG_PARAM)}
				onOpenToken={(token) => setParams({ [LOG_PARAM]: token })}
				onAttributeFilter={addAttributeFilter}
				scrollRef={scrollRef}
				onStreamInspect={reportStreamInspect}
				live={
					canLiveTail(range)
						? (reloadButton: ReactNode) => (
								<LogsLiveControls
									value={refresh}
									onChange={(next) => setParams({ [REFRESH_PARAM]: refreshParam(next) })}
									state={live}
									onJumpToLatest={jumpToLatest}
									reloadButton={reloadButton}
								/>
							)
						: undefined
				}
			/>
		)

	return (
		<>
			{ticker}
			{page}
		</>
	)
}

/** Reloads every `intervalMs` while mounted. The page unmounts it to hold the tail. */
function LiveTailTicker({ intervalMs, onTick }: { intervalMs: number; onTick: () => void }) {
	const tick = useEffectEvent(onTick)
	useMountEffect(() => {
		const id = setInterval(() => tick(), intervalMs)
		return () => clearInterval(id)
	})
	return null
}

function LogPatternsMode({
	filters,
	bounds,
	scope,
	renderPage,
	emptyState,
	onSelect,
}: {
	filters: LogFilters
	bounds: TimeBounds
	scope: ProjectScope
	renderPage: RenderPage
	emptyState: ReactNode
	onSelect: (pattern: LogPattern) => void
}) {
	const patterns = useLocalLogPatterns(filters, bounds, scope)
	const data = patterns.data
	const stat = data ? (
		<>
			<ToolbarStat value={data.patterns.length} label="patterns" />
			<span title={data.truncated ? "Clustered from the newest logs only" : undefined}>
				<ToolbarStat value={data.totalSampled} label={data.truncated ? "logs+" : "logs"} />
			</span>
		</>
	) : null

	return renderPage({
		stat,
		since: patterns.dataUpdatedAt,
		children: patterns.isPending ? (
			<ListSkeleton variant="table" />
		) : failedWithoutData(patterns) ? (
			<ErrorState label="log patterns" error={patterns.error} onRetry={() => patterns.refetch()} />
		) : data === undefined || data.patterns.length === 0 ? (
			emptyState
		) : (
			<LogPatternsList
				patterns={data.patterns}
				totalSampled={data.totalSampled}
				dimmed={patterns.isPlaceholderData}
				onSelect={onSelect}
			/>
		),
	})
}

function LogListMode({
	filters,
	bounds,
	anchorMs,
	range,
	scope,
	renderPage,
	emptyState,
	zoomedFrom,
	onZoomToBucket,
	onUnzoom,
	openToken,
	onOpenToken,
	onAttributeFilter,
	scrollRef,
	onStreamInspect,
	live,
}: {
	filters: LogFilters
	bounds: TimeBounds
	anchorMs: number
	range: string
	scope: ProjectScope
	renderPage: RenderPage
	emptyState: ReactNode
	/** The preset a histogram zoom came from, or `null` when not zoomed. */
	zoomedFrom: string | null
	onZoomToBucket: (bucket: LogHistogramBucket) => void
	onUnzoom: (range: string) => void
	/** The URL's `log` token: the drawer's subject, shareable. */
	openToken: string | null
	onOpenToken: (token: string | null) => void
	onAttributeFilter: (filter: LogAttributeFilter) => void
	scrollRef: RefObject<HTMLDivElement | null>
	onStreamInspect: (patch: Partial<StreamInspect>) => void
	/** The live-tail controls around the reload button; absent for a custom range. */
	live: LiveSlot | undefined
}) {
	const histogram = useLocalLogHistogram(filters, bounds, scope)
	const logs = useLocalLogs(filters, bounds, scope)
	const { hasNextPage, isFetchingNextPage, fetchNextPage } = logs

	const rows = useMemo<ReadonlyArray<LocalLog>>(() => logs.data?.pages.flat() ?? [], [logs.data])

	// The drawer follows the URL's `log` token. Its subject is the row that was
	// clicked, else the loaded row the token names, else a lookup by key (a
	// pasted permalink, or a neighbour picked from the Context tab).
	const openKey = useMemo(() => decodeLogKey(openToken), [openToken])
	const [picked, setPicked] = useState<LocalLog | null>(null)
	const fromPicked = picked && openKey && matchesLogKey(picked, openKey) ? picked : null
	const fromList = fromPicked || !openKey ? undefined : rows.find((row) => matchesLogKey(row, openKey))
	const lookup = useLocalLogByKey(fromPicked || fromList || !openKey ? null : openKey)
	const selectedLog = fromPicked ?? fromList ?? lookup.data ?? null
	// Kept through the close animation, which runs after the token is gone.
	const [shownLog, setShownLog] = useState<LocalLog | null>(null)
	if (selectedLog && selectedLog !== shownLog) setShownLog(selectedLog)
	const selectedKey = selectedLog ? logKey(selectedLog) : null
	// A token that names nothing (malformed, or no such row) would hold the live
	// tail behind a drawer that never opens; drop it.
	const deadToken = openToken !== null && (openKey === null || lookup.data === null)
	useLayoutEffect(() => {
		if (deadToken) onOpenToken(null)
	}, [deadToken, onOpenToken])

	const openLog = useCallback(
		(log: LocalLog) => {
			setPicked(log)
			onOpenToken(encodeLogKey(log))
		},
		[onOpenToken],
	)

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 12,
		// Load the next page as the last row scrolls into view.
		onChange: (instance) => {
			const last = instance.getVirtualItems().at(-1)
			if (last && last.index >= rows.length - 1 && hasNextPage && !isFetchingNextPage)
				void fetchNextPage()
		},
	})

	// No stream (loading, error, empty) means no pointer or scroll to release a
	// hold with, so a hold the stream was keeping is dropped with it.
	const hasStream = rows.length > 0 && !logs.isPending && !failedWithoutData(logs)
	useLayoutEffect(() => {
		if (!hasStream) onStreamInspect({ hovering: false, scrolledAway: false })
	}, [hasStream, onStreamInspect])
	useLayoutEffect(() => () => onStreamInspect({ hovering: false, scrolledAway: false }), [onStreamInspect])

	const volume = histogram.data ?? EMPTY_LOG_HISTOGRAM
	// The window as asked for (unpadded), for the empty strip's baseline labels.
	const requestedWindow = resolveRangeWindow(range, anchorMs)

	return renderPage({
		// No loaded-rows stat: the headline count above the histogram is the
		// window's total, summed from the chart's own buckets.
		stat: null,
		since: logs.dataUpdatedAt,
		live,
		children: (
			<div className="flex h-full min-h-0 flex-col">
				{/* Hidden only until the first answer: once the histogram has
				    spoken, an empty window keeps the strip's height as a silhouette
				    rather than collapsing and moving the list under the pointer. */}
				{histogram.data ? (
					<div className="shrink-0 border-b px-4 pb-1 pt-3">
						<div className="mb-1 flex items-baseline gap-2">
							{/* The count is summed from the very buckets drawn below it,
							    not from a second COUNT(*) — two queries over one window
							    can disagree at its edges, and a headline number that
							    disagrees with the chart under it is worse than no
							    headline number. */}
							<span className="text-sm font-medium tabular-nums">
								{formatNumber(volume.total)}
							</span>
							<span className="text-xs text-muted-foreground">
								{volume.total === 1 ? "log" : "logs"} in selected range
							</span>
							{zoomedFrom ? (
								<button
									type="button"
									className="ml-auto rounded-sm border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
									onClick={() => onUnzoom(zoomedFrom)}
								>
									Zoomed — reset
								</button>
							) : null}
						</div>
						{volume.total > 0 && volume.buckets.length > 0 ? (
							<LogSeverityHistogram
								histogram={volume}
								stale={histogram.isFetching}
								onZoomToBucket={onZoomToBucket}
							/>
						) : (
							<EmptyLogVolumeStrip
								startMs={requestedWindow.startMs}
								endMs={requestedWindow.endMs}
								bucketSeconds={logHistogramBucketSeconds(bounds)}
								stale={histogram.isFetching}
							/>
						)}
					</div>
				) : null}

				<div className="min-h-0 flex-1">
					{logs.isPending ? (
						<ListSkeleton variant="table" />
					) : failedWithoutData(logs) ? (
						<ErrorState label="logs" error={logs.error} onRetry={() => logs.refetch()} />
					) : rows.length === 0 ? (
						emptyState
					) : (
						<div
							className="relative h-full"
							onPointerEnter={() => onStreamInspect({ hovering: true })}
							onPointerLeave={() => onStreamInspect({ hovering: false })}
						>
							<div
								ref={scrollRef}
								onScroll={(event) =>
									onStreamInspect({ scrolledAway: event.currentTarget.scrollTop > 0 })
								}
								className={cn(
									"@container/log absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-contain",
									logs.isPlaceholderData && "opacity-60 transition-opacity",
								)}
							>
								<ColumnHeader />
								<div
									role="list"
									aria-label="Logs"
									style={{ height: virtualizer.getTotalSize(), position: "relative" }}
								>
									{virtualizer.getVirtualItems().map((virtualRow) => {
										const log = rows[virtualRow.index]
										return (
											<LogRow
												key={virtualRow.key}
												log={log}
												search={filters.search}
												top={virtualRow.start}
												height={virtualRow.size}
												selected={selectedKey === logKey(log)}
												onClick={openLog}
												onAttributeFilter={onAttributeFilter}
											/>
										)
									})}
								</div>
								{isFetchingNextPage ? (
									<div className="flex justify-center p-3">
										<Spinner className="size-4" />
									</div>
								) : null}
							</div>
						</div>
					)}
				</div>

				<LogDetailSheet
					log={selectedLog ?? shownLog}
					open={selectedLog !== null}
					onOpenChange={(open) => {
						if (!open) onOpenToken(null)
					}}
					onAttributeFilter={onAttributeFilter}
					onSelectLog={openLog}
				/>
			</div>
		),
	})
}

/** Sticky column labels, always shown: a dense stream without them reads as a wall of text. */
function ColumnHeader() {
	return (
		<Eyebrow
			as="div"
			className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background px-4 py-1.5 select-none"
		>
			<span className="w-36 shrink-0" title="Local time">
				Time
			</span>
			<span className="hidden w-11 shrink-0 md:inline-block">Level</span>
			<span className="hidden w-32 shrink-0 lg:inline-block">Service</span>
			<span className="min-w-0 flex-1">Message</span>
		</Eyebrow>
	)
}

/** Left-edge rail (and, for errors, a tint) so a scan down the stream stops on what is wrong. */
const SEVERITY_ROW = new Map([
	["FATAL", "before:bg-severity-error bg-severity-error/[0.08]"],
	["CRITICAL", "before:bg-severity-error bg-severity-error/[0.08]"],
	["ERROR", "before:bg-severity-error bg-severity-error/[0.05]"],
	["WARN", "before:bg-severity-warn"],
	["WARNING", "before:bg-severity-warn"],
])

/** Debug and trace chatter is read last, so its message is set back a step. */
const QUIET_SEVERITIES = new Set(["DEBUG", "TRACE"])

function LogRow({
	log,
	search,
	top,
	height,
	selected,
	onClick,
	onAttributeFilter,
}: {
	log: LocalLog
	search: string | undefined
	top: number
	height: number
	selected: boolean
	onClick: (log: LocalLog) => void
	onAttributeFilter: (filter: LogAttributeFilter) => void
}) {
	// Only chips that add to the message: resource attributes repeat down the whole
	// stream, and a value the body already spells out is said twice.
	const chips = useMemo(
		() =>
			pickImportantAttributes(log, Number.POSITIVE_INFINITY)
				.filter(
					(attr) =>
						attr.source === "log" && !(attr.value.length >= 3 && log.body.includes(attr.value)),
				)
				.slice(0, VISIBLE_CHIPS),
		[log],
	)
	// ANSI color codes are stripped for display only; copy and Raw keep the original.
	// The row shows one line: the first, or the first that matches the search, so a
	// hit further down a multi-line body is still visible in the row.
	const firstLine = useMemo(() => {
		const lines = stripAnsi(log.body).split("\n")
		const needle = search?.toLowerCase()
		const match = needle ? lines.find((line) => line.toLowerCase().includes(needle)) : undefined
		return { text: match ?? lines[0] ?? "", hidden: lines.length - 1 }
	}, [log.body, search])
	const severity = severityLabel(log.severityText, log.severityNumber).toUpperCase()
	const { copy } = useCopy({ successMessage: "Copied log message" })
	const { copy: copyLink } = useCopy({ successMessage: "Copied link to log" })

	return (
		<div
			data-selected={selected || undefined}
			style={{
				position: "absolute",
				insetInline: 0,
				top: 0,
				transform: `translateY(${top}px)`,
				height,
			}}
			className={cn(
				"group/row flex cursor-pointer items-center gap-3 border-b px-4 font-mono text-xs",
				"before:absolute before:inset-y-0 before:left-0 before:w-0.5",
				"hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none data-[selected]:bg-primary/5",
				SEVERITY_ROW.get(severity),
			)}
			tabIndex={0}
			role="listitem"
			aria-label={`${severity} ${log.serviceName}: ${log.body.slice(0, 120)}`}
			onClick={() => onClick(log)}
			onKeyDown={(e) => {
				// Keys pressed on a nested control (chips, row actions) belong to it, not the row.
				if (e.target !== e.currentTarget) return
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault()
					onClick(log)
				}
			}}
		>
			<span
				className="w-36 shrink-0 truncate text-foreground/75 tabular-nums"
				title={formatUtcTitle(log.timestamp)}
			>
				<LogTime timestamp={log.timestamp} />
			</span>
			<span
				className="hidden w-11 shrink-0 truncate text-3xs font-semibold tracking-wide uppercase tabular-nums md:inline-block"
				style={{ color: getSeverityColor(severity) }}
				title={severity}
			>
				{severity}
			</span>
			<span className="hidden w-32 min-w-0 shrink-0 items-center gap-1.5 text-muted-foreground lg:flex">
				<ServiceDot serviceName={log.serviceName} size="sm" />
				<span className="truncate" title={log.serviceName}>
					{log.serviceName}
				</span>
			</span>
			<span className="flex min-w-0 flex-1 items-center gap-2">
				{/* The message keeps at least 60% of the lane; chips clip after it. */}
				<span
					className={cn(
						"min-w-[60%] truncate",
						QUIET_SEVERITIES.has(severity) ? "text-muted-foreground" : "text-foreground",
					)}
					title={log.body}
				>
					<HighlightedText text={firstLine.text} query={search} />
				</span>
				{firstLine.hidden > 0 && (
					<Badge variant="meta" size="xs" className="shrink-0">
						+{countLabel(firstLine.hidden, "line")}
					</Badge>
				)}
				{chips.length > 0 && (
					// A chip that does not fit wraps onto a hidden second line, so chips
					// drop out whole instead of clipping mid-word; a narrow stream shows none.
					<span className="ml-auto hidden h-[18px] min-w-0 flex-wrap justify-end gap-1 overflow-hidden pl-2 @3xl/log:flex">
						{chips.map((chip) => (
							<LogAttributeChip
								key={chip.key}
								attrKey={chip.key}
								value={chip.value}
								tone={chip.tone}
								className="max-w-full"
								onFilter={(key, value, negated) =>
									onAttributeFilter({ source: chip.source, key, value, negated })
								}
							/>
						))}
					</span>
				)}
			</span>
			{/* Row actions on hover or keyboard focus. A wide stream reserves their
			    slot so they never cover a chip; a narrow one overlays them. */}
			<span
				className={cn(
					"absolute top-1/2 right-2 hidden -translate-y-1/2 items-center gap-0.5 rounded-md border bg-background p-0.5 group-focus-within/row:flex group-hover/row:flex",
					"@3xl/log:static @3xl/log:flex @3xl/log:shrink-0 @3xl/log:translate-y-0 @3xl/log:invisible @3xl/log:group-focus-within/row:visible @3xl/log:group-hover/row:visible",
				)}
			>
				<IconButton
					label="Copy message"
					size="icon-xs"
					className="text-muted-foreground hover:text-foreground"
					onClick={(e) => {
						e.stopPropagation()
						void copy(log.body)
					}}
				>
					<CopyIcon size={13} />
				</IconButton>
				<IconButton
					label="Copy link to log"
					size="icon-xs"
					className="text-muted-foreground hover:text-foreground"
					onClick={(e) => {
						e.stopPropagation()
						void copyLink(logPermalink(log))
					}}
				>
					<LinkIcon size={13} />
				</IconButton>
				{log.traceId && (
					<a
						href={hrefFor(
							`/traces/${encodeURIComponent(log.traceId)}`,
							new URLSearchParams(log.spanId ? { spanId: log.spanId } : {}),
						)}
						onClick={(e) => e.stopPropagation()}
						aria-label="Open trace"
						title="Open trace"
						className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
					>
						<PulseIcon size={13} />
					</a>
				)}
				<IconButton
					label="Open details"
					size="icon-xs"
					className="text-muted-foreground hover:text-foreground"
					onClick={(e) => {
						e.stopPropagation()
						onClick(log)
					}}
				>
					<MaximizeIcon size={12} />
				</IconButton>
			</span>
		</div>
	)
}
