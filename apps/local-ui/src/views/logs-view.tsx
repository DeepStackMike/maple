import { useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { LogAttributeChip } from "@maple/ui/components/logs/log-attribute-chip"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { pickImportantAttributes } from "@maple/ui/lib/log-attributes"
import { formatNumber } from "@maple/ui/lib/format"
import { getSeverityColor } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import { FilterSection, SearchableFilterSection } from "@maple/ui/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import {
	useLocalLogEnvironments,
	useLocalLogHistogram,
	useLocalLogs,
	useLocalLogSeverities,
	logHistogramBucketSeconds,
	type LogFilters,
} from "../hooks/use-local-logs"
import { useLocalLogServices } from "../hooks/use-local-log-services"
import { useRange } from "../hooks/use-range"
import { useTimeWindow } from "../hooks/use-time-window"
import { useQueryParams } from "../lib/router"
import {
	customRangeKey,
	formatLocalTimestamp,
	formatUtcTitle,
	parseCustomRange,
	resolveRangeWindow,
	WIDEST_RANGE,
} from "../lib/time"
import {
	EMPTY_LOG_HISTOGRAM,
	orderBySeverity,
	severityColorMap,
	type LogHistogramBucket,
} from "../lib/log-histogram"
import { logKey, type LocalLog } from "../lib/log-shape"
import { LogDetailSheet } from "../components/log-detail-sheet"
import { HighlightedText } from "../components/highlighted-text"
import { PageShell } from "../components/page-shell"
import { SignalEmptyState } from "../components/signal-empty-state"
import { EmptyLogVolumeStrip, LogSeverityHistogram } from "../components/log-severity-histogram"
import { Toolbar, ToolbarSearch, ToolbarStats, TimeRangeSelect, RefreshButton } from "../components/toolbar"
import { ErrorState, ListSkeleton } from "../components/view-states"

const ROW_HEIGHT = 36
const VISIBLE_CHIPS = 4

export function LogsView() {
	const [query, setParams] = useQueryParams()
	const [range, setRange] = useRange()
	const timeWindow = useTimeWindow(range)
	const filters: LogFilters = {
		service: query.get("service") || undefined,
		severity: query.get("severity") || undefined,
		environment: query.get("env") || undefined,
		search: query.get("q") || undefined,
	}

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

	const services = useLocalLogServices(filters, timeWindow.bounds)
	const severities = useLocalLogSeverities(filters, timeWindow.bounds)
	const environments = useLocalLogEnvironments(filters, timeWindow.bounds)
	const histogram = useLocalLogHistogram(filters, timeWindow.bounds)
	const logs = useLocalLogs(filters, timeWindow.bounds)
	const { hasNextPage, isFetchingNextPage, fetchNextPage } = logs

	const rows = useMemo<ReadonlyArray<LocalLog>>(() => logs.data?.pages.flat() ?? [], [logs.data])
	const scrollRef = useRef<HTMLDivElement>(null)

	const [selectedLog, setSelectedLog] = useState<LocalLog | null>(null)
	const [sheetOpen, setSheetOpen] = useState(false)
	const selectedKey = selectedLog ? logKey(selectedLog) : null

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

	const openLog = (log: LocalLog) => {
		setSelectedLog(log)
		setSheetOpen(true)
	}

	const activeFilterCount = [filters.service, filters.severity, filters.environment].filter(Boolean).length
	const clearFilters = () => setParams({ service: null, severity: null, env: null, q: null })

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
			<FilterSidebarHeader
				canClear={activeFilterCount > 0}
				onClear={() => setParams({ service: null, severity: null, env: null })}
			/>
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
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const toolbar = (
		<Toolbar>
			<ToolbarSearch
				query={filters.search ?? ""}
				onSearch={(value) => setParams({ q: value ?? null })}
				placeholder="Search log bodies…"
				className="min-w-48 flex-1"
			/>
			{/* No loaded-rows stat here: the headline count above the histogram is
			    the window's total, summed from the chart's own buckets. */}
			<ToolbarStats className="shrink-0">
				<RefreshButton advance={timeWindow.advance} since={logs.dataUpdatedAt} />
				<TimeRangeSelect value={range} onChange={selectRange} />
			</ToolbarStats>
		</Toolbar>
	)

	const volume = histogram.data ?? EMPTY_LOG_HISTOGRAM
	// The window as asked for (unpadded), for the empty strip's baseline labels.
	const requestedWindow = resolveRangeWindow(range, timeWindow.anchorMs)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar} activeFilterCount={activeFilterCount}>
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
							{zoomed && unzoomTo ? (
								<button
									type="button"
									className="ml-auto rounded-sm border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
									onClick={() => selectRange(unzoomTo)}
								>
									Zoomed — reset
								</button>
							) : null}
						</div>
						{volume.total > 0 && volume.buckets.length > 0 ? (
							<LogSeverityHistogram
								histogram={volume}
								stale={histogram.isFetching}
								onZoomToBucket={zoomToBucket}
							/>
						) : (
							<EmptyLogVolumeStrip
								startMs={requestedWindow.startMs}
								endMs={requestedWindow.endMs}
								bucketSeconds={logHistogramBucketSeconds(timeWindow.bounds)}
								stale={histogram.isFetching}
							/>
						)}
					</div>
				) : null}

				<div className="min-h-0 flex-1">
					{logs.isPending ? (
						<ListSkeleton variant="table" />
					) : logs.isError ? (
						<ErrorState label="logs" error={logs.error} onRetry={() => logs.refetch()} />
					) : rows.length === 0 ? (
						<SignalEmptyState
							signal="logs"
							filtered={activeFilterCount > 0 || !!filters.search}
							onClearFilters={clearFilters}
							range={range}
							onWidenRange={() => selectRange(WIDEST_RANGE)}
						/>
					) : (
						<div
							ref={scrollRef}
							role="list"
							aria-label="Logs"
							className={cn(
								"h-full overflow-auto",
								logs.isPlaceholderData && "opacity-60 transition-opacity",
							)}
						>
							<div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
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
					)}
				</div>
			</div>

			<LogDetailSheet log={selectedLog} open={sheetOpen} onOpenChange={setSheetOpen} />
		</PageShell>
	)
}

function LogRow({
	log,
	search,
	top,
	height,
	selected,
	onClick,
}: {
	log: LocalLog
	search: string | undefined
	top: number
	height: number
	selected: boolean
	onClick: (log: LocalLog) => void
}) {
	const chips = useMemo(() => pickImportantAttributes(log, VISIBLE_CHIPS), [log])
	const severityColor = getSeverityColor(log.severityText)

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
			className="flex cursor-pointer items-center gap-3 border-b px-4 font-mono text-xs hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none data-[selected]:bg-primary/5"
			tabIndex={0}
			role="listitem"
			aria-label={`${log.severityText} ${log.serviceName}: ${log.body.slice(0, 120)}`}
			onClick={() => onClick(log)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault()
					onClick(log)
				}
			}}
		>
			{/* A dot rather than the left-edge stripe this row used to carry. The
			    stripe was the only severity signal below `md`, where the level word
			    is hidden — but it sat outside the row's own rhythm and read as a
			    selection marker. The dot keeps the signal at every width and sits
			    where the eye already starts the row. */}
			<span
				className="size-2 shrink-0 rounded-full"
				style={{ backgroundColor: severityColor }}
				title={log.severityText || "no severity"}
			/>
			<span
				className="hidden w-12 shrink-0 text-[10px] font-semibold uppercase tabular-nums md:inline-block"
				style={{ color: severityColor }}
			>
				{log.severityText}
			</span>
			<span
				className="w-36 shrink-0 truncate text-muted-foreground tabular-nums"
				title={formatUtcTitle(log.timestamp)}
			>
				{formatLocalTimestamp(log.timestamp)}
			</span>
			<span
				className="hidden w-32 shrink-0 truncate text-muted-foreground/70 lg:inline-block"
				title={log.serviceName}
			>
				{log.serviceName}
			</span>
			{/* The message has priority: it keeps at least 40% of the row, and chips
			    that do not fit wrap onto a clipped second line instead of squeezing it. */}
			<span className="min-w-[40%] flex-1 truncate" title={log.body}>
				<HighlightedText text={log.body} query={search} />
			</span>
			{chips.length > 0 && (
				<div className="hidden h-5 min-w-0 max-w-[30%] flex-wrap items-center justify-end gap-1 overflow-hidden md:flex">
					{chips.map((chip) => (
						<LogAttributeChip
							key={chip.key}
							attrKey={chip.key}
							value={chip.value}
							tone={chip.tone}
						/>
					))}
				</div>
			)}
		</div>
	)
}
