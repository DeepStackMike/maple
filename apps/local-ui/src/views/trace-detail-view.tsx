import { isTraceView } from "@maple/ui/components/traces/trace-view-tabs"
import { Button } from "@maple/ui/components/ui/button"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { ArrowLeftIcon } from "@maple/ui/components/icons"
import { useLocalTraceDetail } from "../hooks/use-local-trace-detail"
import type { SpanPanelTab } from "../components/span-detail-panel"
import { TraceWaterfall } from "../components/trace-waterfall"
import { RefreshButton } from "../components/toolbar"
import { EmptyState, ErrorState } from "../components/view-states"
import { type ParamUpdates, useQueryParams } from "../lib/router"

interface TraceDetailViewProps {
	traceId: string
	backLabel: string
	onBack: () => void
}

export function TraceDetailView({ traceId, backLabel, onBack }: TraceDetailViewProps) {
	const trace = useLocalTraceDetail(traceId)
	const [query, setParams] = useQueryParams()
	// The selected span, its panel tab and the view live in the URL, so a reload
	// or a shared link reopens them. An absent tab means the details tab.
	const selectedSpanId = query.get("spanId") || undefined
	const rawView = query.get("view")
	const view = isTraceView(rawView) ? rawView : undefined
	const panelTab: SpanPanelTab = query.get("spanTab") === "logs" ? "logs" : "details"

	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
					<ArrowLeftIcon size={14} />
					{backLabel}
				</Button>
				<span className="truncate font-mono text-xs text-muted-foreground" title={traceId}>
					{traceId}
				</span>
				<RefreshButton className="ml-auto" since={trace.dataUpdatedAt} />
			</div>

			<div className="min-h-0 flex-1">
				{trace.isPending ? (
					<div className="flex h-full items-center justify-center">
						<Spinner />
					</div>
				) : trace.isError ? (
					<ErrorState label="trace" error={trace.error} onRetry={() => trace.refetch()} />
				) : trace.data.spans.length === 0 ? (
					<EmptyState
						title="No spans found for this trace"
						hint="It may be outside the store's retention, or its spans have not arrived yet."
					/>
				) : (
					<TraceWaterfall
						traceId={traceId}
						data={trace.data}
						selectedSpanId={selectedSpanId}
						onSelectSpan={(spanId) =>
							setParams(spanId ? { spanId } : { spanId: null, spanTab: null })
						}
						panelTab={panelTab}
						onPanelTabChange={(tab, spanId) => {
							const updates: ParamUpdates = {
								spanTab: tab === "details" ? null : tab,
							}
							if (spanId) updates.spanId = spanId
							setParams(updates)
						}}
						view={view ?? "timeline"}
						onViewChange={(next) => setParams({ view: next === "timeline" ? null : next })}
					/>
				)}
			</div>
		</div>
	)
}
