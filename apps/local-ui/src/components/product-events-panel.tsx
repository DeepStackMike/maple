// The Analytics tab's product-events panel: which events fired in the range,
// and — for the one selected — when they fired and what they carried.
//
// Selection and the breakdown key are URL state owned by the view; this
// component is the form and the tables over them.

import { useMemo } from "react"
import type { UseQueryResult } from "@tanstack/react-query"
import { Badge } from "@maple/ui/components/ui/badge"
import { NativeSelect, NativeSelectOption } from "@maple/ui/components/ui/native-select"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { QueryBuilderLineChart } from "@maple/ui/components/charts/line/query-builder-line-chart"
import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import {
	useLocalProductEventPropertyKeys,
	useLocalProductEventPropertyValues,
	useLocalProductEventTimeseries,
	type ProductEventName,
} from "../hooks/use-local-product-events"
import { formatPercent } from "../lib/product-analytics"
import { formatRelativeTime } from "../lib/time"
import { ErrorState } from "./view-states"

interface ProductEventsPanelProps {
	names: UseQueryResult<ReadonlyArray<ProductEventName>, Error>
	range: string
	/** The event whose detail is expanded, or `null` for none. */
	selected: string | null
	onSelect: (next: string | null) => void
	/** The `Attributes` key the breakdown is on; `null` falls back to the first discovered key. */
	propertyKey: string | null
	onPropertyKeyChange: (next: string | null) => void
}

export function ProductEventsPanel({
	names,
	range,
	selected,
	onSelect,
	propertyKey,
	onPropertyKeyChange,
}: ProductEventsPanelProps) {
	const rows = names.data ?? []
	// A page view reaches `product_events` as `$pageview` with `Kind =
	// 'navigation'`; only the custom rows come from a `track()` call, and a feed
	// with none of them is the case the hint below is for.
	const hasCustom = rows.some((row) => row.kind === "custom")

	return (
		<section className="space-y-2">
			<div className="flex items-baseline justify-between gap-3">
				<h3 className="text-sm font-medium">Events</h3>
				<span className="text-xs text-muted-foreground">
					{rows.length.toLocaleString()} {rows.length === 1 ? "name" : "names"} in range
				</span>
			</div>

			{!hasCustom && rows.length > 0 ? (
				<p className="text-xs text-muted-foreground">
					Only page views so far — call{" "}
					<code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
						MapleBrowser.track(name, props)
					</code>{" "}
					to record a custom event.
				</p>
			) : null}

			<div className="rounded-md border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Event</TableHead>
							<TableHead className="text-right">Events</TableHead>
							<TableHead className="text-right">Sessions</TableHead>
							<TableHead className="text-right">Visitors</TableHead>
							<TableHead className="text-right">Last seen</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => (
							<TableRow
								key={`${row.eventName}\x00${row.kind}`}
								onClick={() => onSelect(row.eventName === selected ? null : row.eventName)}
								className={cn("cursor-pointer", row.eventName === selected && "bg-accent/50")}
							>
								<TableCell className="font-mono text-xs">
									<span className="flex items-center gap-2">
										<span className="truncate" title={row.eventName}>
											{row.eventName}
										</span>
										{row.kind === "custom" ? null : (
											<Badge variant="outline" className="px-1 py-0 text-[9px]">
												{row.kind}
											</Badge>
										)}
									</span>
								</TableCell>
								<TableCell className="text-right tabular-nums">
									{row.count.toLocaleString()}
								</TableCell>
								<TableCell className="text-right tabular-nums">
									{row.sessions.toLocaleString()}
								</TableCell>
								{/* Visitors need an `identify()` call (or a v2 SDK visitor id);
								    sessions are the reachable number until then. */}
								<TableCell className="text-right tabular-nums text-muted-foreground">
									{row.persons > 0 ? row.persons.toLocaleString() : "—"}
								</TableCell>
								<TableCell className="text-right text-muted-foreground">
									{formatRelativeTime(row.lastSeen)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>

			{selected === null ? (
				<p className="text-xs text-muted-foreground">
					Select an event to see its trend and properties.
				</p>
			) : (
				<EventDetail
					eventName={selected}
					range={range}
					propertyKey={propertyKey}
					onPropertyKeyChange={onPropertyKeyChange}
				/>
			)}
		</section>
	)
}

function EventDetail({
	eventName,
	range,
	propertyKey,
	onPropertyKeyChange,
}: {
	eventName: string
	range: string
	propertyKey: string | null
	onPropertyKeyChange: (next: string | null) => void
}) {
	const timeseries = useLocalProductEventTimeseries(eventName, range)
	const keys = useLocalProductEventPropertyKeys(eventName, range)
	// The URL key wins; otherwise the most common one, so the breakdown is
	// populated the moment an event is opened.
	const activeKey = propertyKey || keys.data?.[0]?.propertyKey || null
	const values = useLocalProductEventPropertyValues(eventName, activeKey, range)

	// The series is keyed `events` rather than by the event name: the chart
	// reserves `bucket` for the x axis, and a `track('bucket')` call would
	// otherwise draw nothing. The heading already says which event this is.
	const chartData = useMemo(
		() => (timeseries.data ?? []).map((point) => ({ bucket: point.bucket, events: point.count })),
		[timeseries.data],
	)

	const valueRows = values.data ?? []
	const valueTotal = valueRows.reduce((sum, row) => sum + row.count, 0)

	return (
		<div className="space-y-4 rounded-md border bg-muted/20 p-3">
			<div className="space-y-2">
				<h4 className="font-mono text-xs font-medium" title={eventName}>
					{eventName}
				</h4>
				{timeseries.isPending ? (
					<div className="flex h-48 items-center justify-center">
						<Spinner />
					</div>
				) : timeseries.isError ? (
					<ErrorState
						label="event timeseries"
						error={timeseries.error}
						onRetry={() => timeseries.refetch()}
					/>
				) : chartData.length < 2 ? (
					<div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
						Not enough buckets to chart this range.
					</div>
				) : (
					<div className="rounded-md border bg-background p-3">
						<QueryBuilderLineChart
							data={chartData}
							className="h-48 w-full"
							curveType="monotone"
							fitYAxisToData
						/>
					</div>
				)}
			</div>

			<div className="space-y-2">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<label className="flex items-center gap-1.5 text-xs text-muted-foreground">
						Break down by
						<NativeSelect
							size="sm"
							aria-label="Property key"
							value={activeKey ?? ""}
							onChange={(e) => onPropertyKeyChange(e.target.value || null)}
							disabled={(keys.data ?? []).length === 0}
						>
							{(keys.data ?? []).length === 0 ? (
								<NativeSelectOption value="">
									{keys.isPending ? "Loading…" : "No properties"}
								</NativeSelectOption>
							) : null}
							{(keys.data ?? []).map((key) => (
								<NativeSelectOption key={key.propertyKey} value={key.propertyKey}>
									{key.propertyKey}
								</NativeSelectOption>
							))}
							{/* A key carried in from a URL stays selectable even if the
							    event stopped sending it in this range. */}
							{activeKey && !(keys.data ?? []).some((key) => key.propertyKey === activeKey) ? (
								<NativeSelectOption value={activeKey}>{activeKey}</NativeSelectOption>
							) : null}
						</NativeSelect>
					</label>
					{activeKey ? (
						<span className="text-xs text-muted-foreground">
							{formatNumber(valueTotal)} of the event’s firings set it
						</span>
					) : null}
				</div>

				{keys.isSuccess && (keys.data ?? []).length === 0 ? (
					<p className="text-xs text-muted-foreground">
						This event carries no properties. Pass a second argument to{" "}
						<code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">track()</code>{" "}
						to break it down.
					</p>
				) : values.isError ? (
					<ErrorState
						label="property values"
						error={values.error}
						onRetry={() => values.refetch()}
					/>
				) : (
					<div className="rounded-md border bg-background">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="font-mono text-xs font-normal">
										{activeKey ?? "value"}
									</TableHead>
									<TableHead className="text-right">Events</TableHead>
									<TableHead className="text-right">Sessions</TableHead>
									<TableHead className="text-right">Share</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{valueRows.map((row) => (
									<TableRow key={row.propertyValue}>
										<TableCell className="font-mono text-xs">
											{row.propertyValue}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{row.count.toLocaleString()}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{row.sessions.toLocaleString()}
										</TableCell>
										<TableCell className="text-right tabular-nums text-muted-foreground">
											{valueTotal > 0 ? formatPercent(row.count / valueTotal) : "—"}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}
			</div>
		</div>
	)
}
