// Shaping `traceSpanLogCountsQuery`'s rows into the waterfall's marker map.

import type { TraceSpanLogCountsOutput } from "@maple/query-engine/ch"
import type { SpanLogMarker } from "@maple/ui/components/traces/trace-view-context"

/**
 * Index the per-span counts by span id.
 *
 * `Number()` on both counts rather than trusting the wire: the query declares
 * no row schema, so a ClickHouse backend that quotes 64-bit integers would hand
 * back `"3"` — which renders identically and compares `> 0` identically, right
 * up until `errorCount > 0` is asked of the string `"0"` and answers yes.
 *
 * A row with no logs cannot occur (the query groups over rows that exist), but
 * a zero would render an empty badge, so it is dropped here rather than guarded
 * at every render site.
 */
export function toSpanLogMarkers(
	rows: ReadonlyArray<TraceSpanLogCountsOutput>,
): ReadonlyMap<string, SpanLogMarker> {
	const markers = new Map<string, SpanLogMarker>()
	for (const row of rows) {
		const count = Number(row.logCount)
		if (!Number.isFinite(count) || count <= 0) continue
		const errorCount = Number(row.errorLogCount)
		markers.set(row.spanId, {
			count,
			errorCount: Number.isFinite(errorCount) ? errorCount : 0,
		})
	}
	return markers
}
