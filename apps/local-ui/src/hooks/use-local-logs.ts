import { useInfiniteQuery, useQuery, type QueryKey } from "@tanstack/react-query"
import { CH, computeBucketSecondsForRange } from "@maple/query-engine"
import type { FilterOption } from "@maple/ui/components/filters/filter-section"
import { boundsKey, executeLocalCompiledQuery, localParams, noCursor } from "@/lib/query"
import { compareSeverity, normalizeLog, type LocalLog } from "../lib/log-shape"
import { parseClickHouseDateTime, type TimeBounds } from "../lib/time"
import { buildLogHistogram, EMPTY_LOG_HISTOGRAM, type LogHistogram } from "../lib/log-histogram"
import {
	matchesNothing,
	projectKey,
	scopedPlaceholder,
	scopedQueryFn,
	scopeServices,
	type ProjectScope,
} from "../lib/project-scope"

const PAGE_SIZE = 50

/**
 * Columns the histogram aims for across the window.
 *
 * Above the chart-policy default of 100 because this strip is read for shape
 * rather than for values — a two-minute burst of errors is the thing it exists
 * to make visible, and at 100 points a 30-day window averages it into a bucket
 * six hours wide. Every range preset lands between 100 and 210 columns at this
 * target, and the two widest (7d → 1h, 30d → 4h) land on hour-aligned buckets,
 * which is what routes them to `logs_aggregates_hourly` instead of a raw scan.
 */
const HISTOGRAM_TARGET_POINTS = 120

export interface LogFilters {
	/** Exact service name match. */
	service?: string
	/** Exact severity text match (e.g. `ERROR`). */
	severity?: string
	/**
	 * Exact deployment-environment match (e.g. `production`). `unknown` matches
	 * rows with no environment attribute — the query engine reads the column
	 * through `envLabel` on both the facet and the predicate side.
	 */
	environment?: string
	/** Substring match on the log body. */
	search?: string
}

/**
 * The filter set as the query builders spell it — one place, every caller.
 *
 * The header project arrives as its services and is intersected with the
 * sidebar's service (`serviceNames` would otherwise win over `serviceName`
 * outright, so the two cannot both be passed). An empty intersection is
 * answered by the callers without SQL: the logs builders read `[]` as no filter.
 */
export function logsQueryOptions(filters: LogFilters, project: ProjectScope["services"] = undefined) {
	const services = scopeServices(project, filters.service)
	return {
		serviceNames: services,
		severity: filters.severity,
		environments: filters.environment ? [filters.environment] : undefined,
		search: filters.search,
	}
}

type LogCursor = NonNullable<CH.LogsListOpts["cursorIdentity"]>

/**
 * Infinite log stream, newest first. Keyset pagination on the full row
 * identity: a bare timestamp cursor drops every row that shares the boundary
 * timestamp, which batched exporters produce all the time.
 */
export function useLocalLogs(filters: LogFilters, bounds: TimeBounds, scope: ProjectScope) {
	const options = logsQueryOptions(filters, scope.services)
	return useInfiniteQuery({
		queryKey: ["local", "logs", filters, projectKey(scope), boundsKey(bounds)],
		initialPageParam: noCursor<LogCursor>(),
		placeholderData: scopedPlaceholder(scope),
		queryFn: scopedQueryFn<ReadonlyArray<LocalLog>, QueryKey, LogCursor | undefined>(
			scope,
			async ({ pageParam, signal }) => {
				if (matchesNothing(options.serviceNames)) return []
				const compiled = CH.compile(
					CH.logsListQuery({
						limit: PAGE_SIZE,
						cursorIdentity: pageParam,
						...options,
					}),
					localParams(bounds),
				)
				const rows = await executeLocalCompiledQuery(compiled, signal)
				return rows.map(normalizeLog)
			},
		),
		getNextPageParam: (lastPage): LogCursor | undefined => {
			const last = lastPage.length === PAGE_SIZE ? lastPage[lastPage.length - 1] : undefined
			return last
				? {
						timestamp: last.timestamp,
						serviceName: last.serviceName,
						traceId: last.traceId,
						spanId: last.spanId,
						recordIdentity: last.recordIdentity,
					}
				: undefined
		},
	})
}

/**
 * Bucket width for a window, on the shared ladder.
 *
 * Exported so the histogram's cache key and the SQL it compiles cannot drift:
 * the width is part of both, and computing it twice from the same bounds is
 * only safe because this is pure.
 */
export function logHistogramBucketSeconds(bounds: TimeBounds): number {
	return computeBucketSecondsForRange(bounds.startTime, bounds.endTime, "chart", HISTOGRAM_TARGET_POINTS)
}

/**
 * The severity histogram over the list's own window and filters.
 *
 * `logsTimeseriesQuery` grouped by severity is the same builder the hosted
 * volume chart reaches through the custom-chart route, so the strip above the
 * list and the strip above the cloud one are the same numbers from the same
 * SQL. Folding the rows into a dense grid happens here rather than in the view
 * because the window the grid is built against has to be the window the rows
 * were *asked* for — reading it back off the rows would let a range change mid
 * flight silently redefine the axis.
 *
 * `keepPreviousData` because this sits directly above a virtualized list: a
 * chart that unmounts to a skeleton on every filter click moves the list under
 * the pointer that clicked.
 */
export function useLocalLogHistogram(filters: LogFilters, bounds: TimeBounds, scope: ProjectScope) {
	const bucketSeconds = logHistogramBucketSeconds(bounds)
	return useQuery<LogHistogram>({
		queryKey: ["local", "logs", "histogram", filters, projectKey(scope), boundsKey(bounds)],
		placeholderData: scopedPlaceholder(scope),
		queryFn: scopedQueryFn(scope, async ({ signal }) => {
			const startMs = parseClickHouseDateTime(bounds.startTime)
			const endMs = parseClickHouseDateTime(bounds.endTime)
			if (startMs === null || endMs === null) return EMPTY_LOG_HISTOGRAM
			const options = logsQueryOptions(filters, scope.services)
			// Still a real (empty) grid, so the strip keeps its axis.
			if (matchesNothing(options.serviceNames))
				return buildLogHistogram([], { startMs, endMs, bucketSeconds })

			const compiled = CH.compile(
				CH.logsTimeseriesQuery({
					groupBy: ["severity"],
					bucketSeconds,
					...options,
				}),
				{ ...localParams(bounds), bucketSeconds },
			)
			const rows = await executeLocalCompiledQuery(compiled, signal)
			return buildLogHistogram(rows, { startMs, endMs, bucketSeconds })
		}),
	})
}

/**
 * Severity facet: counts under every filter except severity itself, so picking
 * one level never collapses the list of levels. Ordered by level, not count.
 */
export function useLocalLogSeverities(filters: LogFilters, bounds: TimeBounds, scope: ProjectScope) {
	return useQuery<ReadonlyArray<FilterOption>>({
		queryKey: [
			"local",
			"log-severities",
			filters.service ?? null,
			filters.environment ?? null,
			filters.search ?? null,
			projectKey(scope),
			boundsKey(bounds),
		],
		staleTime: 60_000,
		placeholderData: scopedPlaceholder(scope),
		queryFn: scopedQueryFn(scope, async ({ signal }) => {
			const options = logsQueryOptions({ ...filters, severity: undefined }, scope.services)
			if (matchesNothing(options.serviceNames)) return []
			const compiled = CH.compile(
				CH.logsBreakdownQuery({
					groupBy: "severity",
					limit: 20,
					...options,
				}),
				localParams(bounds),
			)
			const rows = await executeLocalCompiledQuery(compiled, signal)
			return rows
				.filter((row) => row.name)
				.map((row) => ({ name: row.name, count: Number(row.count) }))
				.sort((a, b) => compareSeverity(a.name, b.name))
		}),
	})
}

/**
 * Deployment environments that logged in the window, under every filter except
 * the environment itself.
 *
 * `source: "raw"` for the same reason the service facet takes it: the hourly
 * aggregate's `Hour` bound is hour-granular, so a facet read from it can offer
 * an environment whose only traffic falls outside the exact window the list
 * shows — an option that filters the list to nothing. The raw scan is over the
 * same rows and the same bounds the list reads, so every option it offers has
 * at least one row behind it.
 *
 * `limit: null` for the same reason again: a facet is membership, and a top-N
 * over a dimension this small would only ever be a silent truncation.
 *
 * Untagged logs come back as `unknown` (the query engine's `envLabel`), which is
 * a selectable option that matches exactly those rows.
 */
export function useLocalLogEnvironments(filters: LogFilters, bounds: TimeBounds, scope: ProjectScope) {
	return useQuery<ReadonlyArray<FilterOption>>({
		queryKey: [
			"local",
			"logs",
			"environments",
			filters.service ?? null,
			filters.severity ?? null,
			filters.search ?? null,
			projectKey(scope),
			boundsKey(bounds),
		],
		staleTime: 60_000,
		placeholderData: scopedPlaceholder(scope),
		queryFn: scopedQueryFn(scope, async ({ signal }) => {
			const options = logsQueryOptions({ ...filters, environment: undefined }, scope.services)
			if (matchesNothing(options.serviceNames)) return []
			const compiled = CH.compile(
				CH.logsBreakdownQuery({
					groupBy: "environment",
					limit: null,
					source: "raw",
					...options,
				}),
				localParams(bounds),
			)
			const rows = await executeLocalCompiledQuery(compiled, signal)
			return rows.filter((row) => row.name).map((row) => ({ name: row.name, count: Number(row.count) }))
		}),
	})
}
