import * as React from "react"
import { MenuIcon, FireIcon, NetworkNodesIcon } from "../icons"

import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs"
import { SpanHierarchy } from "./span-hierarchy"
import { TraceTimeline } from "./trace-timeline"
import { TraceFlowView } from "./flow-view"
import { TraceViewProvider, type SpanLogMarker } from "./trace-view-context"
import { DEFAULT_COLOR_BY, type ColorByField } from "./color-by"
import type { SpanNode, Span } from "../../lib/types"

interface TraceViewTabsProps {
	rootSpans: SpanNode[]
	spans: Span[]
	totalDurationMs: number
	traceStartTime: string
	services: string[]
	selectedSpanId?: string
	onSelectSpan?: (span: SpanNode) => void
	/**
	 * Per-span log counts, keyed by span id. Omit them and the views render as
	 * they always have — the marker is a decoration a caller opts into by
	 * having the counts, not something a trace is expected to carry.
	 */
	spanLogMarkers?: ReadonlyMap<string, SpanLogMarker>
	/** Clicking a log marker; typically "select this span and show its logs". */
	onOpenSpanLogs?: (span: SpanNode) => void
}

export function TraceViewTabs({
	rootSpans,
	spans: _spans,
	totalDurationMs,
	traceStartTime,
	services,
	selectedSpanId,
	onSelectSpan,
	spanLogMarkers,
	onOpenSpanLogs,
}: TraceViewTabsProps) {
	// _spans is reserved for future Flow view implementation
	const [colorBy, setColorBy] = React.useState<ColorByField>(DEFAULT_COLOR_BY)

	return (
		<TraceViewProvider
			rootSpans={rootSpans}
			totalDurationMs={totalDurationMs}
			traceStartTime={traceStartTime}
			services={services}
			selectedSpanId={selectedSpanId}
			onSelectSpan={onSelectSpan}
			colorBy={colorBy}
			setColorBy={setColorBy}
			spanLogMarkers={spanLogMarkers}
			onOpenSpanLogs={onOpenSpanLogs}
		>
			<Tabs defaultValue="timeline" className="flex flex-col h-full">
				<TabsList variant="underline" className="shrink-0">
					<TabsTrigger value="waterfall">
						<MenuIcon size={14} />
						Waterfall
					</TabsTrigger>
					<TabsTrigger value="timeline">
						<FireIcon size={14} />
						Timeline
					</TabsTrigger>
					<TabsTrigger value="flow">
						<NetworkNodesIcon size={14} />
						Flow
					</TabsTrigger>
				</TabsList>

				<TabsContent value="waterfall" className="flex-1 min-h-0">
					<SpanHierarchy />
				</TabsContent>

				<TabsContent value="timeline" className="flex-1 min-h-0">
					<TraceTimeline />
				</TabsContent>

				<TabsContent value="flow" className="flex-1 min-h-0">
					<TraceFlowView
						rootSpans={rootSpans}
						totalDurationMs={totalDurationMs}
						traceStartTime={traceStartTime}
						services={services}
						selectedSpanId={selectedSpanId}
						onSelectSpan={onSelectSpan}
					/>
				</TabsContent>
			</Tabs>
		</TraceViewProvider>
	)
}
