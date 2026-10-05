// The trace's vital signs, for the peek sheet's summary strip. A local port of
// the hosted app's `TraceAnatomyStrip`: total duration as the dominant figure,
// the per-service share of wall-clock time, and the trace metadata as one quiet
// row. The hosted commit-SHA hover card is left out — it needs the VCS
// integration, which Maple Local has none of.

import { useMemo } from "react"
import { CopyableValue } from "@maple/ui/components/attributes"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { ServiceSpectrumBar, computeServiceShares } from "@maple/ui/components/traces/service-spectrum-bar"
import { formatDuration } from "@maple/ui/lib/format"
import { getHttpInfo } from "@maple/ui/lib/http"
import type { TraceDetail } from "@maple/ui/lib/span-tree"
import type { Span } from "@maple/ui/lib/types"
import { cn } from "@maple/ui/lib/utils"

function httpStatusColor(code: number): string {
	if (code >= 500) return "text-severity-error"
	if (code >= 400) return "text-severity-warn"
	if (code >= 300) return "text-chart-p50"
	return "text-severity-info"
}

/** A span that failed: an `Error` status, or a 5xx the instrumentation didn't flag. */
function spanFailed(span: Span): boolean {
	if (span.statusCode === "Error") return true
	const raw =
		span.spanAttributes?.["http.response.status_code"] || span.spanAttributes?.["http.status_code"]
	const code = raw ? Number.parseInt(raw, 10) : Number.NaN
	return Number.isFinite(code) && code >= 500
}

export function TraceAnatomyStrip({ traceId, data }: { traceId: string; data: TraceDetail }) {
	const shares = useMemo(() => computeServiceShares(data.spans), [data.spans])
	const rootSpan = data.rootSpans[0]
	const httpStatusCode = rootSpan ? getHttpInfo(rootSpan)?.statusCode : undefined
	const hasError = data.spans.some(spanFailed)
	const deploymentEnv =
		rootSpan?.resourceAttributes?.["deployment.environment.name"] ||
		rootSpan?.resourceAttributes?.["deployment.environment"]
	const spanCount = data.spans.length

	return (
		<div className="shrink-0 space-y-2">
			<div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
				<div className="flex min-w-0 items-baseline gap-3">
					<span className="font-mono text-2xl font-semibold tracking-tight tabular-nums">
						{formatDuration(data.totalDurationMs)}
					</span>
					<span className="text-xs text-muted-foreground">
						{spanCount} span{spanCount !== 1 ? "s" : ""} · {shares.length} service
						{shares.length !== 1 ? "s" : ""}
					</span>
				</div>

				<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
					<span
						className={cn(
							"flex items-center gap-1.5 font-medium",
							hasError ? "text-severity-error" : "text-severity-info",
						)}
					>
						<span aria-hidden className="size-1.5 rounded-full bg-current" />
						{hasError ? "Error" : "OK"}
					</span>
					{httpStatusCode != null ? (
						<span className={cn("font-mono font-medium", httpStatusColor(httpStatusCode))}>
							HTTP {httpStatusCode}
						</span>
					) : null}
					{deploymentEnv ? (
						<span
							className={
								deploymentEnv === "production" ? "text-severity-warn" : "text-chart-p50"
							}
						>
							{deploymentEnv}
						</span>
					) : null}
					<span className="max-w-[12rem] truncate font-mono" title={traceId}>
						<CopyableValue value={traceId}>{traceId}</CopyableValue>
					</span>
				</div>
			</div>

			<ServiceSpectrumBar shares={shares} />

			<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
				{shares.map((share) => (
					<span key={share.serviceName} className="flex items-center gap-1.5 font-mono text-xs">
						<ServiceDot serviceName={share.serviceName} className="size-1.5" />
						<span>{share.serviceName}</span>
						<span className="text-[10px] text-muted-foreground tabular-nums">
							{share.percent.toFixed(share.percent < 10 ? 1 : 0)}%
						</span>
					</span>
				))}
			</div>
		</div>
	)
}
