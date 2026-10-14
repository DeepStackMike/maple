import { useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { clusterLogPatterns, type LogPattern } from "@maple/query-engine/observability"
import { boundsKey, executeLocalCompiledQuery, localParams } from "@/lib/query"
import type { TimeBounds } from "../lib/time"
import {
	matchesNothing,
	projectKey,
	scopedPlaceholder,
	scopedQueryFn,
	type ProjectScope,
} from "../lib/project-scope"
import { logsQueryOptions, type LogFilters } from "./use-local-logs"

/** Newest logs clustered per refresh. Smaller than the CLI's 10k: chDB serves one query at a time. */
export const PATTERN_SAMPLE_SIZE = 5_000
const PATTERN_LIMIT = 100

export interface LocalLogPatterns {
	readonly patterns: ReadonlyArray<LogPattern>
	readonly totalSampled: number
	/** True when the sample hit its cap, so counts cover only the newest logs. */
	readonly truncated: boolean
}

/**
 * Drain templates over the newest logs matching the list's filters, the same
 * clustering `maple log-patterns` runs, done in the browser on a list sample.
 */
export function useLocalLogPatterns(filters: LogFilters, bounds: TimeBounds, scope: ProjectScope) {
	return useQuery<LocalLogPatterns>({
		queryKey: ["local", "log-patterns", filters, projectKey(scope), boundsKey(bounds)],
		staleTime: 30_000,
		placeholderData: scopedPlaceholder(scope),
		queryFn: scopedQueryFn(scope, async ({ signal }) => {
			// The same filter set the list sends (project, environment, attributes included).
			const options = logsQueryOptions(filters, scope.services)
			if (matchesNothing(options.serviceNames))
				return { patterns: [], totalSampled: 0, truncated: false }
			const compiled = CH.compile(
				CH.logsListQuery({
					limit: PATTERN_SAMPLE_SIZE,
					...options,
				}),
				localParams(bounds),
			)
			const rows = await executeLocalCompiledQuery(compiled, signal)
			const { patterns } = clusterLogPatterns(rows, PATTERN_LIMIT)
			return {
				patterns,
				// clusterLogPatterns skips empty bodies, so they stay out of the share denominator.
				totalSampled: rows.filter((row) => String(row.body ?? "") !== "").length,
				truncated: rows.length >= PATTERN_SAMPLE_SIZE,
			}
		}),
	})
}
