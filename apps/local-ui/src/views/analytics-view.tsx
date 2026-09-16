// Analytics — product events and funnels over `product_events`.
//
// Deliberately a stack of independent panels under one shared toolbar rather
// than a tabbed page: each panel owns its own queries and its own URL params,
// and the range select above them is the only thing they share. Web-analytics
// panels (sessions, page views) drop into the same stack without touching what
// is already here.

import { SquareActivityChartIcon } from "@maple/ui/components/icons"
import { useLocalProductEventNames } from "../hooks/use-local-product-events"
import {
	decodeFunnelSteps,
	encodeFunnelSteps,
	funnelStepSlots,
	parseConversionWindow,
} from "../lib/product-analytics"
import { useQueryParams } from "../lib/router"
import { DEFAULT_RANGE } from "../lib/time"
import { FunnelPanel } from "../components/funnel-panel"
import { ProductEventsPanel } from "../components/product-events-panel"
import { RefreshButton, TimeRangeSelect, Toolbar, ToolbarStat, ToolbarStats } from "../components/toolbar"
import { EmptyState, ErrorState, ListSkeleton } from "../components/view-states"

export function AnalyticsView() {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || DEFAULT_RANGE
	const selected = query.get("event")
	const propertyKey = query.get("prop")
	const steps = funnelStepSlots(decodeFunnelSteps(query.get("steps")))
	const conversionWindow = parseConversionWindow(query.get("window"))

	// One query behind both panels: the table's rows and the funnel picker's
	// options are the same list.
	const names = useLocalProductEventNames(range)
	const rows = names.data ?? []
	const totalEvents = rows.reduce((sum, row) => sum + row.count, 0)

	const toolbar = (
		<Toolbar>
			<span className="text-sm text-muted-foreground">Product analytics</span>
			<ToolbarStats>
				<ToolbarStat value={rows.length} label="event names" />
				<ToolbarStat value={totalEvents} label="events" />
				<RefreshButton />
				<TimeRangeSelect value={range} onChange={(next) => setParams({ range: next })} />
			</ToolbarStats>
		</Toolbar>
	)

	return (
		<div className="flex h-full flex-col">
			{toolbar}
			<div className="min-h-0 flex-1 overflow-auto">
				{names.isPending ? (
					<ListSkeleton rows={6} />
				) : names.isError ? (
					<ErrorState label="product events" error={names.error} onRetry={() => names.refetch()} />
				) : rows.length === 0 ? (
					<EmptyState
						icon={<SquareActivityChartIcon />}
						title="No product events yet"
						hint={
							<>
								Call{" "}
								<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em]">
									MapleBrowser.track(name, props)
								</code>{" "}
								in the browser SDK to record one. Page views arrive the same way, and any app
								that sends a session event with{" "}
								<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em]">
									type: "custom"
								</code>{" "}
								shows up here too. Widen the time range if you have sent some already.
							</>
						}
					/>
				) : (
					<div className="space-y-8 p-4">
						<ProductEventsPanel
							names={names}
							range={range}
							selected={selected}
							onSelect={(next) => setParams({ event: next, prop: null })}
							propertyKey={propertyKey}
							onPropertyKeyChange={(next) => setParams({ prop: next })}
						/>
						<FunnelPanel
							names={names}
							range={range}
							steps={steps}
							onStepsChange={(next) => setParams({ steps: encodeFunnelSteps(next) || null })}
							conversionWindow={conversionWindow}
							onConversionWindowChange={(next) => setParams({ window: next })}
						/>
						{/* Web analytics (sessions, page views) appends here. */}
					</div>
				)}
			</div>
		</div>
	)
}
