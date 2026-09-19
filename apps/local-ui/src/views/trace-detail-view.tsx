import { useCallback, useState } from "react"
import { TraceViewTabs } from "@maple/ui/components/traces/trace-view-tabs"
import { Button } from "@maple/ui/components/ui/button"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { ArrowLeftIcon } from "@maple/ui/components/icons"
import type { SpanNode } from "@maple/ui/lib/types"
import { useLocalTraceDetail } from "../hooks/use-local-trace-detail"
import { useLocalTraceLogCounts } from "../hooks/use-local-span-logs"
import { SpanDetailPanel, type SpanPanelTab } from "../components/span-detail-panel"
import { RefreshButton } from "../components/toolbar"

interface TraceDetailViewProps {
	traceId: string
	onBack: () => void
}

export function TraceDetailView({ traceId, onBack }: TraceDetailViewProps) {
	const { data, isPending, isError, error } = useLocalTraceDetail(traceId)
	const [selectedSpan, setSelectedSpan] = useState<SpanNode | undefined>(undefined)
	const [panelTab, setPanelTab] = useState<SpanPanelTab>("details")

	// One query for the trace, not one per span: which rows have logs is a
	// property of the whole waterfall, wanted before anything is clicked.
	const logCounts = useLocalTraceLogCounts(traceId)

	// A marker click says both things at once — this span, and its logs. Picking
	// a row the ordinary way leaves the tab alone, so a reader working through a
	// trace log-first keeps the logs tab across selections.
	const openSpanLogs = useCallback((span: SpanNode) => {
		setSelectedSpan(span)
		setPanelTab("logs")
	}, [])

	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
					<ArrowLeftIcon size={14} />
					Traces
				</Button>
				<span className="truncate font-mono text-xs text-muted-foreground" title={traceId}>
					{traceId}
				</span>
				<RefreshButton className="ml-auto" />
			</div>

			<div className="min-h-0 flex-1">
				{isPending ? (
					<div className="flex h-full items-center justify-center">
						<Spinner />
					</div>
				) : isError ? (
					<div className="p-6 text-sm text-destructive">
						Failed to load trace: {error instanceof Error ? error.message : String(error)}
					</div>
				) : !data || data.spans.length === 0 ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						No spans found for this trace.
					</div>
				) : (
					<div className="flex h-full min-h-0">
						<div className="min-w-0 flex-1">
							<TraceViewTabs
								rootSpans={data.rootSpans}
								spans={data.spans}
								totalDurationMs={data.totalDurationMs}
								traceStartTime={data.traceStartTime}
								services={data.services}
								selectedSpanId={selectedSpan?.spanId}
								onSelectSpan={setSelectedSpan}
								spanLogMarkers={logCounts.data}
								onOpenSpanLogs={openSpanLogs}
							/>
						</div>
						{selectedSpan ? (
							<SpanDetailPanel
								span={selectedSpan}
								tab={panelTab}
								onTabChange={setPanelTab}
								onClose={() => setSelectedSpan(undefined)}
							/>
						) : null}
					</div>
				)}
			</div>
		</div>
	)
}
