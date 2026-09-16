// Analytics — two sections over the same browser SDK data, under one range.
//
// **Web** is what the cloud `/analytics` route is: sessions, page views, and
// the dimensions they arrived by, read from `session_replays` and
// `session_events`. **Product** is local mode's addition: the `track()` events
// in `product_events` and funnels over them.
//
// A switcher rather than one stacked page, which is what this file used to be.
// The two halves have different empty states and they are not each other's
// caveat: a Maple with sessions but no `track()` call is a completely normal
// Maple, and stacking meant its Product empty state blanked the Web panels
// underneath it. The section lives in the hash (`section`), so each half is a
// link, and each owns its own params — `event` / `prop` / `steps` / `window`
// for Product, `utm` for Web — so switching back restores what you had.

import { SquareActivityChartIcon } from "@maple/ui/components/icons"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import type { ReactNode } from "react"
import { useLocalProductEventNames } from "../hooks/use-local-product-events"
import {
	decodeFunnelSteps,
	encodeFunnelSteps,
	funnelStepSlots,
	parseConversionWindow,
} from "../lib/product-analytics"
import { useQueryParams } from "../lib/router"
import { DEFAULT_RANGE } from "../lib/time"
import { ANALYTICS_SECTIONS, resolveAnalyticsSection } from "../lib/web-analytics"
import { FunnelPanel } from "../components/funnel-panel"
import { ProductEventsPanel } from "../components/product-events-panel"
import { WebAnalyticsPanel, parseUtmDimension } from "../components/web-analytics-panel"
import { RefreshButton, TimeRangeSelect, Toolbar, ToolbarStat, ToolbarStats } from "../components/toolbar"
import { EmptyState, ErrorState, ListSkeleton } from "../components/view-states"

export function AnalyticsView() {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || DEFAULT_RANGE
	// A link minted before the switcher existed carries product state and no
	// `section`; sending it to Web would hide the very thing it addressed.
	const section = resolveAnalyticsSection(
		query.get("section"),
		query.get("event") !== null || query.get("steps") !== null,
	)

	// Shared by both sections, and rendered by each so the stats between the
	// label and these controls can be the section's own.
	const controls = (
		<>
			<RefreshButton />
			<TimeRangeSelect value={range} onChange={(next) => setParams({ range: next })} />
		</>
	)

	const switcher = (
		<Tabs
			className="gap-0"
			value={section}
			onValueChange={(next) => setParams({ section: String(next) })}
		>
			<TabsList variant="underline">
				{ANALYTICS_SECTIONS.map((option) => (
					<TabsTrigger key={option.key} value={option.key} className="h-7 text-xs">
						{option.label}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	)

	return section === "web" ? (
		<WebSection
			range={range}
			switcher={switcher}
			controls={controls}
			utm={parseUtmDimension(query.get("utm"))}
			onUtmChange={(next) => setParams({ utm: next })}
		/>
	) : (
		<ProductSection
			range={range}
			switcher={switcher}
			controls={controls}
			selected={query.get("event")}
			onSelect={(next) => setParams({ event: next, prop: null })}
			propertyKey={query.get("prop")}
			onPropertyKeyChange={(next) => setParams({ prop: next })}
			steps={funnelStepSlots(decodeFunnelSteps(query.get("steps")))}
			onStepsChange={(next) => setParams({ steps: encodeFunnelSteps(next) || null })}
			conversionWindow={parseConversionWindow(query.get("window"))}
			onConversionWindowChange={(next) => setParams({ window: next })}
		/>
	)
}

function WebSection({
	range,
	switcher,
	controls,
	utm,
	onUtmChange,
}: {
	range: string
	switcher: ReactNode
	controls: ReactNode
	utm: ReturnType<typeof parseUtmDimension>
	onUtmChange: (next: ReturnType<typeof parseUtmDimension>) => void
}) {
	return (
		<Section switcher={switcher} controls={controls}>
			<div className="p-4">
				<WebAnalyticsPanel range={range} utm={utm} onUtmChange={onUtmChange} />
			</div>
		</Section>
	)
}

/**
 * The product half, unchanged: one query behind both panels, because the
 * table's rows and the funnel picker's options are the same list.
 */
function ProductSection({
	range,
	switcher,
	controls,
	selected,
	onSelect,
	propertyKey,
	onPropertyKeyChange,
	steps,
	onStepsChange,
	conversionWindow,
	onConversionWindowChange,
}: {
	range: string
	switcher: ReactNode
	controls: ReactNode
	selected: string | null
	onSelect: (next: string | null) => void
	propertyKey: string | null
	onPropertyKeyChange: (next: string | null) => void
	steps: string[]
	onStepsChange: (next: ReadonlyArray<string>) => void
	conversionWindow: ReturnType<typeof parseConversionWindow>
	onConversionWindowChange: (next: string) => void
}) {
	const names = useLocalProductEventNames(range)
	const rows = names.data ?? []
	const totalEvents = rows.reduce((sum, row) => sum + row.count, 0)

	const stats = (
		<>
			<ToolbarStat value={rows.length} label="event names" />
			<ToolbarStat value={totalEvents} label="events" />
		</>
	)

	return (
		<Section switcher={switcher} controls={controls} stats={stats}>
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
							in the browser SDK to record one. Page views arrive the same way, and any app that
							sends a session event with{" "}
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
						onSelect={onSelect}
						propertyKey={propertyKey}
						onPropertyKeyChange={onPropertyKeyChange}
					/>
					<FunnelPanel
						names={names}
						range={range}
						steps={steps}
						onStepsChange={onStepsChange}
						conversionWindow={conversionWindow}
						onConversionWindowChange={onConversionWindowChange}
					/>
				</div>
			)}
		</Section>
	)
}

/** The shell both sections render into: switcher, the section's own stats, the shared controls. */
function Section({
	switcher,
	controls,
	stats,
	children,
}: {
	switcher: ReactNode
	controls: ReactNode
	stats?: ReactNode
	children: ReactNode
}) {
	return (
		<div className="flex h-full flex-col">
			<Toolbar>
				{switcher}
				<ToolbarStats>
					{stats}
					{controls}
				</ToolbarStats>
			</Toolbar>
			<div className="min-h-0 flex-1 overflow-auto">{children}</div>
		</div>
	)
}
