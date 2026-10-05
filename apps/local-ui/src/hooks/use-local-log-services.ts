import { useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import type { FilterOption } from "@maple/ui/components/filters/filter-section"
import { boundsKey, executeLocalCompiledQuery, localParams } from "@/lib/query"
import {
	matchesNothing,
	projectKey,
	scopedPlaceholder,
	scopedQueryFn,
	type ProjectScope,
	type ProjectServices,
} from "../lib/project-scope"
import type { TimeBounds } from "../lib/time"
import type { LogFilters } from "./use-local-logs"

/**
 * Distinct services that emitted logs in the selected window, under every log
 * filter except the service itself. Scans the same raw table and exact bounds
 * as the rendered list, so hourly aggregates can never add or hide an option.
 *
 * `project` (the header project's services) is a page-wide scope rather than
 * this facet's own dimension, so it does apply: the facet lists only the
 * project's services. An empty project is the caller's to answer — `[]` here
 * would read as no filter.
 */
export function compileLocalLogServicesQuery(
	startTime: string,
	endTime: string,
	filters: Pick<LogFilters, "severity" | "environment" | "search"> = {},
	project: ProjectServices = undefined,
) {
	return CH.compile(
		CH.logsBreakdownQuery({
			groupBy: "service",
			limit: null,
			source: "raw",
			serviceNames: project,
			severity: filters.severity,
			environments: filters.environment ? [filters.environment] : undefined,
			search: filters.search,
		}),
		localParams({ startTime, endTime }),
	)
}

export function useLocalLogServices(filters: LogFilters, bounds: TimeBounds, scope: ProjectScope) {
	return useQuery<ReadonlyArray<FilterOption>>({
		queryKey: [
			"local",
			"logs",
			"services",
			filters.severity ?? null,
			filters.environment ?? null,
			filters.search ?? null,
			projectKey(scope),
			boundsKey(bounds),
		],
		staleTime: 60_000,
		placeholderData: scopedPlaceholder(scope),
		queryFn: scopedQueryFn(scope, async ({ signal }) => {
			if (matchesNothing(scope.services)) return []
			const compiled = compileLocalLogServicesQuery(
				bounds.startTime,
				bounds.endTime,
				filters,
				scope.services,
			)
			const rows = await executeLocalCompiledQuery(compiled, signal)
			return rows.filter((row) => row.name).map((row) => ({ name: row.name, count: Number(row.count) }))
		}),
	})
}
