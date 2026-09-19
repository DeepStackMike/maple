import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { CH, computeBucketSecondsForRange } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { parseClickHouseDateTime, type TimeBounds } from "../lib/time"
import { buildLogHistogram, EMPTY_LOG_HISTOGRAM, type LogHistogram } from "../lib/log-histogram"
import type { FilterOption } from "@maple/ui/components/filters/filter-section"

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
	/** Exact deployment-environment match (e.g. `production`). */
	environment?: string
	/** Substring match on the log body. */
	search?: string
}

/** The filter set as the query builders spell it — one place, four callers. */
function logsQueryOptions(filters: LogFilters) {
	return {
		serviceName: filters.service,
		severity: filters.severity,
		environments: filters.environment ? [filters.environment] : undefined,
		search: filters.search,
	}
}

/**
 * Infinite log stream, newest first. Keyset pagination on `Timestamp` — the
 * cursor is the last row's `timestamp`.
 */
export function useLocalLogs(filters: LogFilters, bounds: TimeBounds) {
	return useInfiniteQuery({
		queryKey: ["local", "logs", filters, bounds.startTime, bounds.endTime],
		initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam }) => {
			const compiled = CH.compile(
				CH.logsListQuery({
					limit: PAGE_SIZE,
					cursor: pageParam,
					...logsQueryOptions(filters),
				}),
				{ orgId: LOCAL_ORG_ID, ...bounds },
			)
			return executeLocalCompiledQuery(compiled)
		},
		getNextPageParam: (lastPage) =>
			lastPage.length === PAGE_SIZE ? lastPage[lastPage.length - 1]?.timestamp : undefined,
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
export function useLocalLogHistogram(filters: LogFilters, bounds: TimeBounds) {
	const bucketSeconds = logHistogramBucketSeconds(bounds)
	return useQuery<LogHistogram>({
		queryKey: ["local", "logs", "histogram", filters, bounds.startTime, bounds.endTime],
		placeholderData: keepPreviousData,
		queryFn: async () => {
			const startMs = parseClickHouseDateTime(bounds.startTime)
			const endMs = parseClickHouseDateTime(bounds.endTime)
			if (startMs === null || endMs === null) return EMPTY_LOG_HISTOGRAM

			const compiled = CH.compile(
				CH.logsTimeseriesQuery({
					groupBy: ["severity"],
					bucketSeconds,
					...logsQueryOptions(filters),
				}),
				{ orgId: LOCAL_ORG_ID, ...bounds, bucketSeconds },
			)
			const rows = await executeLocalCompiledQuery(compiled)
			return buildLogHistogram(rows, { startMs, endMs, bucketSeconds })
		},
	})
}

/**
 * Distinct severity values in the window (with counts), for the severity facet.
 * Derived from the data so the option casing always matches what's stored.
 */
export function useLocalLogSeverities(bounds: TimeBounds) {
	return useQuery<ReadonlyArray<FilterOption>>({
		queryKey: ["local", "log-severities", bounds.startTime, bounds.endTime],
		staleTime: 60_000,
		queryFn: async () => {
			const compiled = CH.compile(CH.logsBreakdownQuery({ groupBy: "severity", limit: 20 }), {
				orgId: LOCAL_ORG_ID,
				...bounds,
			})
			const rows = await executeLocalCompiledQuery(compiled)
			return rows.filter((row) => row.name).map((row) => ({ name: row.name, count: row.count }))
		},
	})
}

/**
 * Deployment environments that logged in the window.
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
 */
export function useLocalLogEnvironments(bounds: TimeBounds) {
	return useQuery<ReadonlyArray<FilterOption>>({
		queryKey: ["local", "logs", "environments", bounds.startTime, bounds.endTime],
		staleTime: 60_000,
		queryFn: async () => {
			const compiled = CH.compile(
				CH.logsBreakdownQuery({ groupBy: "environment", limit: null, source: "raw" }),
				{ orgId: LOCAL_ORG_ID, ...bounds },
			)
			const rows = await executeLocalCompiledQuery(compiled)
			// An empty name is every log whose resource carries no
			// `deployment.environment` at all, which is most of them locally. It is
			// not an environment, and a row labelled "" filters on nothing.
			return rows.filter((row) => row.name).map((row) => ({ name: row.name, count: Number(row.count) }))
		},
	})
}
