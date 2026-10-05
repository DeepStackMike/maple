import { skipToken, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import type { SpanLogMarker } from "@maple/ui/components/traces/trace-view-context"
import { executeLocalCompiledQuery, localParams } from "@/lib/query"
import { normalizeLog, type LocalLog } from "../lib/log-shape"
import { toSpanLogMarkers } from "../lib/log-markers"
import { boundsForRange, parseClickHouseDateTime, toClickHouseDateTime, WIDEST_RANGE } from "../lib/time"

const HOUR_MS = 60 * 60 * 1000

/**
 * The whole of local mode's history, as ClickHouse bounds.
 *
 * The trace-wide log counts are pinned to a trace, so the window is not what
 * makes them cheap — the `(TraceId)` index is. A narrower window would only be
 * able to miss: a trace opened from a link can be older than whatever range the
 * list was showing when it was copied.
 */
const allTimeBounds = () => ({
	startTime: toClickHouseDateTime(0),
	endTime: toClickHouseDateTime(Date.now() + HOUR_MS),
})

/**
 * Logs emitted within one span, newest first (the span detail's Logs tab).
 * Bounded to the span's own window ±1h: its logs cannot drift further, and an
 * unbounded scan reads every partition on each span click.
 */
export function useLocalSpanLogs(
	traceId: string | undefined,
	spanId: string | undefined,
	spanStartTime: string,
	spanDurationMs: number,
) {
	return useQuery<ReadonlyArray<LocalLog>>({
		queryKey: ["local", "span-logs", traceId, spanId, spanStartTime, spanDurationMs],
		queryFn:
			traceId && spanId
				? async ({ signal }) => {
						const startMs = parseClickHouseDateTime(spanStartTime)
						const bounds =
							startMs === null
								? boundsForRange(WIDEST_RANGE)
								: {
										startTime: toClickHouseDateTime(startMs - HOUR_MS),
										endTime: toClickHouseDateTime(
											startMs + Math.max(0, spanDurationMs) + HOUR_MS,
										),
									}
						const compiled = CH.compile(
							CH.logsListQuery({ traceId, spanId, limit: 100 }),
							localParams(bounds),
						)
						const rows = await executeLocalCompiledQuery(compiled, signal)
						return rows.map(normalizeLog)
					}
				: skipToken,
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
		queryFn: traceId
			? async ({ signal }) => {
					const compiled = CH.compile(
						CH.traceSpanLogCountsQuery({ traceId }),
						localParams(allTimeBounds()),
					)
					return toSpanLogMarkers(await executeLocalCompiledQuery(compiled, signal))
				}
			: skipToken,
	})
}
