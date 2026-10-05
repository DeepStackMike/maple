// The trace's waterfall with its span panel beside it — the body the trace page
// and the list's peek sheet share. Selection, the panel's tab and the view are
// all controlled, because each host keeps them in different URL params (the
// page's `spanId`, the peek's `peekSpan`).

import { useCallback, useMemo } from "react"
import { TraceViewTabs, type TraceView } from "@maple/ui/components/traces/trace-view-tabs"
import type { TraceDetail } from "@maple/ui/lib/span-tree"
import type { SpanNode } from "@maple/ui/lib/types"
import { useLocalTraceLogCounts } from "../hooks/use-local-span-logs"
import { SpanDetailPanel, type SpanPanelTab } from "./span-detail-panel"

/** Depth-first lookup of a span in the rendered tree (the panel needs the node, children included). */
export function findSpanNode(nodes: ReadonlyArray<SpanNode>, spanId: string): SpanNode | undefined {
	for (const node of nodes) {
		if (node.spanId === spanId) return node
		const found = findSpanNode(node.children, spanId)
		if (found) return found
	}
	return undefined
}

export interface TraceWaterfallProps {
	traceId: string
	data: TraceDetail
	selectedSpanId: string | undefined
	/** `undefined` closes the panel. */
	onSelectSpan: (spanId: string | undefined) => void
	panelTab: SpanPanelTab
	/**
	 * A tab change, optionally with the span it applies to: a log marker's click
	 * says "this span, on its logs" in one gesture.
	 */
	onPanelTabChange: (tab: SpanPanelTab, spanId?: string) => void
	view?: TraceView
	onViewChange?: (view: TraceView) => void
}

export function TraceWaterfall({
	traceId,
	data,
	selectedSpanId,
	onSelectSpan,
	panelTab,
	onPanelTabChange,
	view,
	onViewChange,
}: TraceWaterfallProps) {
	const selectedSpan = useMemo(
		() => (selectedSpanId ? findSpanNode(data.rootSpans, selectedSpanId) : undefined),
		[selectedSpanId, data.rootSpans],
	)

	// One query for the trace, not one per span: which rows have logs is a
	// property of the whole waterfall, wanted before anything is clicked.
	const logCounts = useLocalTraceLogCounts(traceId)

	// Picking a row the ordinary way leaves the tab alone, so a reader working
	// through a trace log-first keeps the logs tab across selections.
	const selectSpan = useCallback((span: SpanNode) => onSelectSpan(span.spanId), [onSelectSpan])
	const openSpanLogs = useCallback(
		(span: SpanNode) => onPanelTabChange("logs", span.spanId),
		[onPanelTabChange],
	)

	return (
		<div className="flex h-full min-h-0">
			<div className="min-w-0 flex-1">
				<TraceViewTabs
					rootSpans={data.rootSpans}
					spans={data.spans}
					totalDurationMs={data.totalDurationMs}
					traceStartTime={data.traceStartTime}
					services={data.services}
					selectedSpanId={selectedSpan?.spanId}
					onSelectSpan={selectSpan}
					spanLogMarkers={logCounts.data}
					onOpenSpanLogs={openSpanLogs}
					view={view}
					onViewChange={onViewChange}
				/>
			</div>
			{selectedSpan ? (
				<SpanDetailPanel
					span={selectedSpan}
					tab={panelTab}
					onTabChange={(next) => onPanelTabChange(next)}
					onClose={() => onSelectSpan(undefined)}
				/>
			) : null}
		</div>
	)
}
