import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { LogAttributeChip } from "@maple/ui/components/logs/log-attribute-chip"
import { CodeIcon } from "@maple/ui/components/icons"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { pickImportantAttributes } from "@maple/ui/lib/log-attributes"
import { formatNumber } from "@maple/ui/lib/format"
import { getSeverityColor } from "@maple/ui/lib/severity"
import {
	useLocalLogEnvironments,
	useLocalLogHistogram,
	useLocalLogs,
	useLocalLogSeverities,
} from "../hooks/use-local-logs"
import { useLocalLogServices } from "../hooks/use-local-log-services"
import { useLogTimeWindow } from "../hooks/use-log-time-window"
import { useQueryParams } from "../lib/router"
import { DEFAULT_RANGE, toClickHouseDateTime } from "../lib/time"
import { EMPTY_LOG_HISTOGRAM, orderBySeverity, severityColorMap } from "../lib/log-histogram"
import { normalizeLog, type LocalLog } from "../lib/log-shape"
import { LogDetailSheet } from "../components/log-detail-sheet"
import { LogSeverityHistogram } from "../components/log-severity-histogram"
import { FilterSection, SearchableFilterSection } from "@maple/ui/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import { PageShell } from "../components/page-shell"
import { Toolbar, ToolbarSearch, ToolbarStats, TimeRangeSelect, RefreshButton } from "../components/toolbar"
import { EmptyState, ErrorState, ListSkeleton } from "../components/view-states"

const ROW_HEIGHT = 36
const VISIBLE_CHIPS = 4

export function LogsView() {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || DEFAULT_RANGE
	const service = query.get("service") || undefined
	const severity = query.get("severity") || undefined
	const environment = query.get("env") || undefined
	const search = query.get("q") || undefined
	const timeWindow = useLogTimeWindow(range)

	/**
	 * A window pinned to one histogram column, set by clicking it.
	 *
	 * An override rather than a sixth entry in `TIME_RANGES`: the presets are a
	 * fixed vocabulary the range `<select>` renders, and a bucket's window is an
	 * arbitrary pair of instants. Holding it in its own two params leaves the
	 * preset the page will return to untouched, so dismissing the zoom is a
	 * matter of dropping two keys rather than remembering what was selected
	 * before — and the zoomed view is still a shareable URL.
	 */
	const zoomStart = query.get("from") || undefined
	const zoomEnd = query.get("to") || undefined
	const zoomed = zoomStart && zoomEnd ? { startTime: zoomStart, endTime: zoomEnd } : null
	const bounds = zoomed ?? timeWindow.bounds

	const updateParamsWithFreshTimeWindow = useCallback(
		(updates: Record<string, string | null | undefined>) => {
			timeWindow.advance()
			setParams(updates)
		},
		[setParams, timeWindow.advance],
	)

	const services = useLocalLogServices(bounds)
	const severities = useLocalLogSeverities(bounds)
	const environments = useLocalLogEnvironments(bounds)
	const histogram = useLocalLogHistogram({ service, severity, environment, search }, bounds)
	const { data, isPending, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useLocalLogs({ service, severity, environment, search }, bounds)

	const rows = useMemo<ReadonlyArray<LocalLog>>(() => (data?.pages.flat() ?? []).map(normalizeLog), [data])
	const scrollRef = useRef<HTMLDivElement>(null)

	const [selectedLog, setSelectedLog] = useState<LocalLog | null>(null)
	const [sheetOpen, setSheetOpen] = useState(false)

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 12,
	})

	const virtualItems = virtualizer.getVirtualItems()
	useEffect(() => {
		const last = virtualItems[virtualItems.length - 1]
		if (!last) return
		if (last.index >= rows.length - 1 && hasNextPage && !isFetchingNextPage) {
			fetchNextPage()
		}
	}, [virtualItems, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage])

	const openLog = (log: LocalLog) => {
		setSelectedLog(log)
		setSheetOpen(true)
	}

	const hasActiveFilters = !!service || !!severity || !!environment

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
				canClear={hasActiveFilters}
				onClear={() => updateParamsWithFreshTimeWindow({ service: null, severity: null, env: null })}
			/>
			<FilterSidebarBody>
				<FilterSection
					title="Severity"
					options={severityOptions}
					selected={severity ? [severity] : []}
					onChange={(vals) => updateParamsWithFreshTimeWindow({ severity: vals.at(-1) ?? null })}
					colorMap={severityColors}
				/>
				<FilterSection
					title="Environment"
					options={(environments.data ?? []).map((o) => ({ name: o.name, count: o.count }))}
					selected={environment ? [environment] : []}
					onChange={(vals) => updateParamsWithFreshTimeWindow({ env: vals.at(-1) ?? null })}
				/>
				<SearchableFilterSection
					title="Service"
					options={(services.data ?? []).map((o) => ({ name: o.name, count: o.count }))}
					selected={service ? [service] : []}
					onChange={(vals) => updateParamsWithFreshTimeWindow({ service: vals.at(-1) ?? null })}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const toolbar = (
		<Toolbar>
			<ToolbarSearch
				query={search ?? ""}
				onSearch={(value) => updateParamsWithFreshTimeWindow({ q: value ?? null })}
				placeholder="Search log bodies…"
			/>
			<ToolbarStats>
				<RefreshButton onBeforeRefresh={timeWindow.advance} />
				<TimeRangeSelect
					value={range}
					// Picking a preset is the explicit way out of a zoom: the window it
					// names and the window a column pinned cannot both be in force.
					onChange={(next) =>
						updateParamsWithFreshTimeWindow({ range: next, from: null, to: null })
					}
				/>
			</ToolbarStats>
		</Toolbar>
	)

	const volume = histogram.data ?? EMPTY_LOG_HISTOGRAM

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar}>
			<div className="flex h-full min-h-0 flex-col">
				{volume.buckets.length > 0 ? (
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
							{zoomed ? (
								<button
									type="button"
									className="ml-auto rounded-sm border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
									onClick={() => setParams({ from: null, to: null })}
								>
									Zoomed — reset
								</button>
							) : null}
						</div>
						<LogSeverityHistogram
							histogram={volume}
							stale={histogram.isFetching}
							onZoomToBucket={(bucket) =>
								setParams({
									from: toClickHouseDateTime(bucket.startMs),
									to: toClickHouseDateTime(bucket.endMs),
								})
							}
						/>
					</div>
				) : null}

				<div className="min-h-0 flex-1">
					{isPending ? (
						<ListSkeleton variant="table" />
					) : isError ? (
						<ErrorState label="logs" error={error} onRetry={() => refetch()} />
					) : rows.length === 0 ? (
						<EmptyState
							icon={<CodeIcon />}
							title={hasActiveFilters || search ? "No matching logs" : "No logs yet"}
							hint={
								hasActiveFilters || search
									? "Try widening the time range or clearing filters."
									: "Send OTLP logs to the local ingest endpoint to get started."
							}
						/>
					) : (
						<div ref={scrollRef} className="h-full overflow-auto">
							<div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
								{virtualItems.map((virtualRow) => {
									const log = rows[virtualRow.index]
									return (
										<LogRow
											key={virtualRow.key}
											log={log}
											top={virtualRow.start}
											height={virtualRow.size}
											selected={selectedLog === log}
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
	top,
	height,
	selected,
	onClick,
}: {
	log: LocalLog
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
			className="flex cursor-pointer items-center gap-3 border-b px-4 font-mono text-xs hover:bg-muted/50 data-[selected]:bg-primary/5"
			tabIndex={0}
			role="listitem"
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
			<span className="w-44 shrink-0 text-muted-foreground tabular-nums">{log.timestamp}</span>
			<span
				className="hidden w-36 shrink-0 truncate text-muted-foreground/70 md:inline-block"
				title={log.serviceName}
			>
				{log.serviceName}
			</span>
			<span className="min-w-0 flex-1 truncate" title={log.body}>
				{log.body}
			</span>
			{chips.length > 0 && (
				<div className="hidden min-w-0 max-w-[45%] shrink items-center gap-1 overflow-hidden md:flex">
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
