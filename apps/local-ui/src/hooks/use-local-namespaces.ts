import { useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { NAMESPACE_LOOKBACK_RANGE } from "../lib/namespace"
import { boundsForRange } from "../lib/time"

export interface LocalNamespace {
	readonly namespace: string
	readonly spanCount: number
}

/**
 * The projects to offer in the header selector, busiest first.
 *
 * Deliberately not keyed on the view's time range: the selector's job is to
 * name every project this Maple has seen recently, and narrowing it to the
 * current window would make the list shrink as the reader zooms in — the one
 * moment a project they cannot currently see is the thing they want to switch
 * to. `NAMESPACE_LOOKBACK_RANGE` fixes the window at a week, so the query has
 * one cache entry for the whole session rather than one per range.
 */
export function useLocalNamespaces() {
	return useQuery<ReadonlyArray<LocalNamespace>>({
		queryKey: ["local", "namespaces"],
		// The set of projects on a dev machine changes when a new one is started,
		// not between clicks.
		staleTime: 5 * 60_000,
		queryFn: async () => {
			const { startTime, endTime } = boundsForRange(NAMESPACE_LOOKBACK_RANGE)
			const rows = await executeLocalCompiledQuery(
				CH.compile(CH.resourceNamespacesQuery(), { orgId: LOCAL_ORG_ID, startTime, endTime }),
			)
			return rows.map((row) => ({ namespace: row.namespace, spanCount: Number(row.spanCount) }))
		},
	})
}
