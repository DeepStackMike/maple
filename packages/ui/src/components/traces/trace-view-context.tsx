import * as React from "react"
import type { ReactNode } from "react"
import type { SpanNode } from "../../lib/types"
import type { ColorByField } from "./color-by"

/** How many logs one span emitted, and how many of those were error level. */
export interface SpanLogMarker {
	readonly count: number
	readonly errorCount: number
}

interface TraceViewContextValue {
	rootSpans: SpanNode[]
	totalDurationMs: number
	traceStartTime: string
	services: string[]
	selectedSpanId?: string
	onSelectSpan?: (span: SpanNode) => void
	colorBy: ColorByField
	setColorBy: (next: ColorByField) => void
	/**
	 * Per-span log counts, keyed by span id — rows carrying one get a marker.
	 *
	 * Optional because it is a decoration, not a part of a trace: a caller that
	 * has no cheap way to count logs for the whole trace at once passes nothing
	 * and every row renders exactly as it did before. Spans absent from the map
	 * have no logs, which is the same thing a count of 0 means, so the lookup
	 * needs no distinction between "none" and "not asked".
	 */
	spanLogMarkers?: ReadonlyMap<string, SpanLogMarker>
	/** Clicking a marker. Without a handler the marker is inert text, not a button. */
	onOpenSpanLogs?: (span: SpanNode) => void
}

const TraceViewContext = React.createContext<TraceViewContextValue | null>(null)

export function TraceViewProvider({ children, ...value }: TraceViewContextValue & { children: ReactNode }) {
	const ctx = React.useMemo(
		() => value,
		[
			value.rootSpans,
			value.totalDurationMs,
			value.traceStartTime,
			value.services,
			value.selectedSpanId,
			value.onSelectSpan,
			value.colorBy,
			value.setColorBy,
			value.spanLogMarkers,
			value.onOpenSpanLogs,
		],
	)
	return <TraceViewContext value={ctx}>{children}</TraceViewContext>
}

export function useTraceView() {
	const ctx = React.use(TraceViewContext)
	if (!ctx) throw new Error("useTraceView must be used within TraceViewProvider")
	return ctx
}
