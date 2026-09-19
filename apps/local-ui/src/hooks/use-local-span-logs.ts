import { useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import type { SpanLogMarker } from "@maple/ui/components/traces/trace-view-context"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { toClickHouseDateTime } from "../lib/time"
import { normalizeLog, type LocalLog } from "../lib/log-shape"
import { toSpanLogMarkers } from "../lib/log-markers"

/**
 * The whole of local mode's history, as ClickHouse bounds.
 *
 * Both queries here are pinned to a trace (and one of them to a span as well),
 * so the window is not what makes them cheap — the `(TraceId)` index is. A
 * narrower window would only be able to miss: a trace opened from a link can be
 * older than whatever range the list was showing when it was copied.
 */
const allTimeBounds = () => ({
	startTime: toClickHouseDateTime(0),
	endTime: toClickHouseDateTime(Date.now() + 60 * 60 * 1000),
})

/**
 * Logs emitted within a single span, newest first. Powers the "Logs" tab of the
 * span detail panel. The list query needs time bounds, so we span the full
 * history (epoch → now+1h) — the `(TraceId, SpanId)` filter keeps the scan tiny
 * on local data regardless of window width.
 */
export function useLocalSpanLogs(traceId: string | undefined, spanId: string | undefined) {
	return useQuery<ReadonlyArray<LocalLog>>({
		queryKey: ["local", "span-logs", traceId, spanId],
		enabled: !!traceId && !!spanId,
		queryFn: async () => {
			const compiled = CH.compile(
				CH.logsListQuery({ traceId: traceId!, spanId: spanId!, limit: 100 }),
				{ orgId: LOCAL_ORG_ID, ...allTimeBounds() },
			)
			const rows = await executeLocalCompiledQuery(compiled)
			return rows.map(normalizeLog)
		},
	})
}

/**
 * How many logs each span of a trace emitted, for the waterfall's markers.
 *
 * One query for the whole trace, keyed on the trace id — not one per span. The
 * panel's `useLocalSpanLogs` is a *reaction* to a click and can afford to be
 * lazy; a marker on every row is the opposite, needed for spans nobody has
 * asked about yet, and asking per row would turn opening a 200-span trace into
 * 200 requests to decorate a list.
 *
 * The result is the `ReadonlyMap` `TraceViewTabs` takes, built once here rather
 * than in the view, so React Query's cache holds the shape the renderer uses
 * and a re-render is a map lookup.
 */
export function useLocalTraceLogCounts(traceId: string | undefined) {
	return useQuery<ReadonlyMap<string, SpanLogMarker>>({
		queryKey: ["local", "trace-log-counts", traceId],
		enabled: !!traceId,
		queryFn: async () => {
			const compiled = CH.compile(CH.traceSpanLogCountsQuery({ traceId: traceId! }), {
				orgId: LOCAL_ORG_ID,
				...allTimeBounds(),
			})
			return toSpanLogMarkers(await executeLocalCompiledQuery(compiled))
		},
	})
}
