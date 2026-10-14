// The trace's waterfall with its span panel beside it — the body the trace page
// and the list's peek sheet share. Selection, the panel's tab and the view are
// all controlled, because each host keeps them in different URL params (the
// page's `spanId`, the peek's `peekSpan`).

import { useCallback, useMemo, type ReactNode } from "react"
import { TraceAnatomyStrip } from "@maple/ui/components/traces/trace-anatomy-strip"
import { TraceViewTabs, type TraceView } from "@maple/ui/components/traces/trace-view-tabs"
import { getHttpInfo, httpStatusTone } from "@maple/ui/lib/http"
import type { TraceDetail } from "@maple/ui/lib/span-tree"
import type { Span, SpanNode } from "@maple/ui/lib/types"
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

/** The first real root: an orphan's synthetic "missing" parent can sort ahead of it. */
export function traceRootSpan(data: TraceDetail): SpanNode | undefined {
	return data.rootSpans.find((span) => !span.isMissing) ?? data.rootSpans[0]
}

/** An Error status, or an HTTP status in the critical band, anywhere in the trace (as on web). */
function traceHasError(spans: ReadonlyArray<Span>): boolean {
	return spans.some((span) => {
		if (span.statusCode === "Error") return true
		const raw =
			span.spanAttributes["http.response.status_code"] || span.spanAttributes["http.status_code"]
		const code = raw ? Number.parseInt(raw, 10) : Number.NaN
		return Number.isFinite(code) && httpStatusTone(code) === "crit"
	})
}

/**
 * The shared `@maple/ui` anatomy strip, fed from a loaded trace. No `commit`
 * slot: the hosted commit hover card needs a VCS integration Local has none of.
 */
export function TraceAnatomy({ traceId, data }: { traceId: string; data: TraceDetail }) {
	const rootSpan = traceRootSpan(data)
	const hasError = useMemo(() => traceHasError(data.spans), [data.spans])
	return (
		<TraceAnatomyStrip
			spans={data.spans}
			totalDurationMs={data.totalDurationMs}
			traceId={traceId}
			hasError={hasError}
			httpStatusCode={rootSpan ? getHttpInfo(rootSpan)?.statusCode : undefined}
			deploymentEnv={
				rootSpan?.resourceAttributes["deployment.environment.name"] ||
				rootSpan?.resourceAttributes["deployment.environment"]
			}
		/>
	)
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
	/** Above the waterfall, beside (not over) the span panel — the trace page's anatomy strip. */
	header?: ReactNode
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
	header,
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
			<div className="flex min-w-0 flex-1 flex-col">
				{header}
				<div className="min-h-0 flex-1">
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
			</div>
			{selectedSpan ? (
				<SpanDetailPanel
					span={selectedSpan}
					traceStartTime={data.traceStartTime}
					totalDurationMs={data.totalDurationMs}
					tab={panelTab}
					onTabChange={(next) => onPanelTabChange(next)}
					onClose={() => onSelectSpan(undefined)}
				/>
			) : null}
		</div>
	)
}
