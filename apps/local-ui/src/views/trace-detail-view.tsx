import { HttpSpanLabel } from "@maple/ui/components/traces/http-span-label"
import { TraceIdBadge } from "@maple/ui/components/traces/trace-id-badge"
import { isTraceView } from "@maple/ui/components/traces/trace-view-tabs"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { ArrowLeftIcon } from "@maple/ui/components/icons"
import { getHttpInfo } from "@maple/ui/lib/http"
import { useLocalTraceDetail } from "../hooks/use-local-trace-detail"
import type { SpanPanelTab } from "../components/span-detail-panel"
import { TraceAnatomy, TraceWaterfall, traceRootSpan } from "../components/trace-waterfall"
import { RefreshButton } from "../components/toolbar"
import { EmptyState, ErrorState } from "../components/view-states"
import { type ParamUpdates, useQueryParams } from "../lib/router"
import { failedWithoutData } from "../lib/query"

interface TraceDetailViewProps {
	traceId: string
	backLabel: string
	onBack: () => void
}

/** Shaped like the loaded page (strip, spectrum bar, waterfall rows) so nothing jumps when it lands. */
function TraceDetailLoading() {
	return (
		<div className="space-y-4 p-4">
			<div className="space-y-2">
				<Skeleton className="h-8 w-32" />
				<Skeleton className="h-1.5 w-full rounded-full" />
				<div className="flex gap-4">
					<Skeleton className="h-4 w-24" />
					<Skeleton className="h-4 w-24" />
					<Skeleton className="h-4 w-24" />
				</div>
			</div>
			<SkeletonList
				rows={8}
				gap="px"
				className="gap-0 rounded-md border"
				renderRow={() => (
					<div className="flex items-center gap-2 border-b p-3">
						<Skeleton className="size-4" />
						<Skeleton className="h-4 w-20" />
						<Skeleton className="h-4 w-16" />
						<Skeleton className="h-4 flex-1" />
						<Skeleton className="h-2 w-32" />
						<Skeleton className="h-4 w-16" />
					</div>
				)}
			/>
		</div>
	)
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
	const rootSpan = trace.data ? traceRootSpan(trace.data) : undefined

	return (
		<div
			className="flex h-full flex-col"
			onKeyDown={(e) => {
				// Escape closes the span panel; a nested sheet or popover that handled it first wins.
				if (e.key === "Escape" && selectedSpanId && !e.defaultPrevented)
					setParams({ spanId: null, spanTab: null })
			}}
		>
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<Button variant="ghost" size="sm" onClick={onBack} className="shrink-0 gap-1.5">
					<ArrowLeftIcon />
					{backLabel}
				</Button>
				<div className="min-w-0 flex-1 text-sm font-semibold">
					{rootSpan ? (
						getHttpInfo(rootSpan) ? (
							<HttpSpanLabel
								spanName={rootSpan.spanName}
								spanAttributes={rootSpan.spanAttributes}
								spanKind={rootSpan.spanKind}
								className="min-w-0 gap-3"
							/>
						) : (
							<span className="block truncate" title={rootSpan.spanName}>
								{rootSpan.spanName}
							</span>
						)
					) : null}
				</div>
				<RefreshButton className="shrink-0" since={trace.dataUpdatedAt} />
			</div>

			<div className="min-h-0 flex-1">
				{trace.isPending ? (
					<TraceDetailLoading />
				) : failedWithoutData(trace) ? (
					<ErrorState label="trace" error={trace.error} onRetry={() => trace.refetch()} />
				) : trace.data.spans.length === 0 ? (
					<EmptyState
						title="Trace not found"
						hint="It may be outside the store's retention, or its spans have not arrived yet."
						action={<TraceIdBadge traceId={traceId} size="default" className="text-xs" />}
					/>
				) : (
					<TraceWaterfall
						traceId={traceId}
						data={trace.data}
						header={
							<div className="shrink-0 border-b px-4 py-3">
								<TraceAnatomy traceId={traceId} data={trace.data} />
							</div>
						}
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
