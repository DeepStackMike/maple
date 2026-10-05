import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { boundsKey, executeLocalCompiledQuery, localParams } from "@/lib/query"
import {
	chartWindow,
	parseClickHouseDateTime,
	rangeWindowSeconds,
	type ChartWindow,
	type TimeBounds,
} from "../lib/time"
import { isCounter, isMetricType } from "../lib/units"
import { projectKey, scopedPlaceholder, scopedQueryFn, type ProjectScope } from "../lib/project-scope"

export interface MetricsFilters {
	/** Exact service name match (applied client-side, so it never re-runs SQL). */
	service?: string
	/** Exact metric type (sum | gauge | histogram | exponential_histogram). */
	type?: string
	/** Substring match on the metric name (toolbar search). */
	search?: string
}

/** One metric across all reporting services, aggregated from the catalog rows. */
export interface MetricEntry {
	metricName: string
	metricType: string
	metricUnit: string
	metricDescription: string
	serviceNames: string[]
	dataPointCount: number
	firstSeen: string
	lastSeen: string
	isMonotonic: boolean
}

export interface MetricsListData {
	/** Entries matching every server-side filter (type, search). */
	entries: MetricEntry[]
	/** Service facet counts (distinct matching metrics per service). */
	serviceFacets: Array<{ name: string; count: number }>
}

/**
 * ~60 buckets across the selected range, floored to 60s for chDB's hourly-ish
 * volumes. Derived from the window's length, so a custom window is bucketed by
 * how long it is rather than by which preset it resembles.
 */
export function bucketSecondsForRange(key: string | undefined): number {
	return Math.max(60, Math.round(rangeWindowSeconds(key) / 60))
}

/** Fold per-service catalog rows into one entry per (metric, type). */
export function foldCatalogRows(rows: ReadonlyArray<CH.ListMetricsOutput>): MetricsListData {
	const byMetric = new Map<string, MetricEntry>()
	const byService = new Map<string, Set<string>>()
	for (const row of rows) {
		const key = `${row.metricName}\x00${row.metricType}`
		const existing = byMetric.get(key)
		if (existing) {
			if (!existing.serviceNames.includes(row.serviceName)) existing.serviceNames.push(row.serviceName)
			existing.dataPointCount += Number(row.dataPointCount)
			if (row.lastSeen > existing.lastSeen) existing.lastSeen = row.lastSeen
			if (row.firstSeen < existing.firstSeen) existing.firstSeen = row.firstSeen
		} else {
			byMetric.set(key, {
				metricName: row.metricName,
				metricType: row.metricType,
				metricUnit: row.metricUnit,
				metricDescription: row.metricDescription,
				serviceNames: [row.serviceName],
				dataPointCount: Number(row.dataPointCount),
				firstSeen: row.firstSeen,
				lastSeen: row.lastSeen,
				isMonotonic: Number(row.isMonotonic) === 1,
			})
		}
		let metricsOfService = byService.get(row.serviceName)
		if (!metricsOfService) byService.set(row.serviceName, (metricsOfService = new Set()))
		metricsOfService.add(key)
	}
	const serviceFacets = [...byService.entries()]
		.map(([name, metrics]) => ({ name, count: metrics.size }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
	return { entries: [...byMetric.values()], serviceFacets }
}

/**
 * Metrics catalog list over the hourly rollup. The service filter is applied
 * with `select` over the cached result, so it doubles as the service facet
 * source and a service click never re-runs SQL.
 *
 * The header project *is* applied in SQL (`services`, the project's services),
 * so the facet lists only the project's services and a sidebar service outside
 * it filters to nothing. The header environment is **not** applied: the
 * catalog rollup (`metric_catalog`) has no environment column, so the list can
 * only say which metrics exist, not in which deployment. The view says so.
 */
export function useLocalMetricsList(filters: MetricsFilters, bounds: TimeBounds, scope: ProjectScope) {
	const query = useQuery({
		queryKey: [
			"local",
			"metrics",
			"list",
			filters.type ?? null,
			filters.search ?? null,
			projectKey(scope),
			boundsKey(bounds),
		],
		placeholderData: scopedPlaceholder(scope),
		queryFn: scopedQueryFn(scope, async ({ signal }): Promise<MetricsListData> => {
			const compiled = CH.compile(
				CH.listMetricsQuery({
					metricType: filters.type,
					search: filters.search,
					services: scope.services,
					limit: 500,
				}),
				localParams(bounds),
			)
			return foldCatalogRows(await executeLocalCompiledQuery(compiled, signal))
		}),
	})
	const service = filters.service
	const allEntries = useMemo(() => query.data?.entries ?? [], [query.data])
	const entries = useMemo(
		() => (service ? allEntries.filter((entry) => entry.serviceNames.includes(service)) : allEntries),
		[allEntries, service],
	)
	return { query, entries, allEntries, serviceFacets: query.data?.serviceFacets ?? [] }
}

export interface MetricsSummaryRow {
	metricType: string
	metricCount: number
	dataPointCount: number
}

/**
 * Per-type metric/datapoint counts over catalog rows — what `metricsSummaryQuery`
 * computes, for when it cannot be used (it takes no service list).
 */
export function summarizeCatalogRows(rows: ReadonlyArray<CH.ListMetricsOutput>): Array<MetricsSummaryRow> {
	const byType = new Map<string, { metrics: Set<string>; dataPointCount: number }>()
	for (const row of rows) {
		let entry = byType.get(row.metricType)
		if (!entry) byType.set(row.metricType, (entry = { metrics: new Set(), dataPointCount: 0 }))
		entry.metrics.add(row.metricName)
		entry.dataPointCount += Number(row.dataPointCount)
	}
	return [...byType.entries()].map(([metricType, entry]) => ({
		metricType,
		metricCount: entry.metrics.size,
		dataPointCount: entry.dataPointCount,
	}))
}

/** Catalog rows read for a project-scoped summary; a local catalog is far below this. */
const PROJECT_SUMMARY_ROW_LIMIT = 10_000

/**
 * Per-type metric/datapoint counts for the summary stats + type facet.
 *
 * `metricsSummaryQuery` takes no service list, so under a header project the
 * same numbers are folded from the project's catalog rows instead
 * ({@link summarizeCatalogRows}) — the same table, grouped one level finer.
 */
export function useLocalMetricsSummary(service: string | undefined, bounds: TimeBounds, scope: ProjectScope) {
	return useQuery({
		queryKey: ["local", "metrics", "summary", service ?? null, projectKey(scope), boundsKey(bounds)],
		placeholderData: scopedPlaceholder(scope),
		queryFn: scopedQueryFn(scope, async ({ signal }): Promise<ReadonlyArray<MetricsSummaryRow>> => {
			if (scope.services !== undefined) {
				const rows = await executeLocalCompiledQuery(
					CH.compile(
						CH.listMetricsQuery({
							serviceName: service,
							services: scope.services,
							limit: PROJECT_SUMMARY_ROW_LIMIT,
						}),
						localParams(bounds),
					),
					signal,
				)
				return summarizeCatalogRows(rows)
			}
			const rows = await executeLocalCompiledQuery(
				CH.compile(CH.metricsSummaryQuery({ serviceName: service }), localParams(bounds)),
				signal,
			)
			return rows.map((r) => ({
				metricType: r.metricType,
				metricCount: Number(r.metricCount),
				dataPointCount: Number(r.dataPointCount),
			}))
		}),
	})
}

export interface SparklinePoint {
	bucket: string
	avgValue: number
	sumValue: number
	dataPointCount: number
}

/**
 * Preview series for a card. Counters preview their rate: the per-bucket rise
 * of the average cumulative value, clamped at resets. That is the rate's shape,
 * not its magnitude (the detail page shows the true per-second rate).
 */
export function previewValues(
	entry: Pick<MetricEntry, "metricType" | "isMonotonic">,
	points: ReadonlyArray<SparklinePoint>,
): Array<{ bucket: string; v: number }> {
	if (!isCounter(entry)) return points.map((point) => ({ bucket: point.bucket, v: point.avgValue }))
	return points.slice(1).map((point, index) => ({
		bucket: point.bucket,
		v: Math.max(0, point.avgValue - points[index].avgValue),
	}))
}

/** The sparkline window for a set of entries: the range clipped to when the oldest started. */
export function sparklineWindow(entries: ReadonlyArray<MetricEntry>, bounds: TimeBounds): ChartWindow {
	const firstSeen = entries.reduce<number | null>((earliest, entry) => {
		const ms = parseClickHouseDateTime(entry.firstSeen)
		return ms !== null && (earliest === null || ms < earliest) ? ms : earliest
	}, null)
	return chartWindow(bounds, firstSeen)
}

/**
 * Batched preview series for the grid: one query per metric type (a true
 * rate needs the window CTE, which must not run one-per-card).
 */
export function useLocalMetricsSparklines(
	entries: ReadonlyArray<MetricEntry>,
	bounds: TimeBounds,
	window: ChartWindow,
	scope: ProjectScope,
) {
	const groups = useMemo(() => {
		const byType = new Map<string, string[]>()
		for (const entry of entries) {
			const names = byType.get(entry.metricType)
			if (names) names.push(entry.metricName)
			else byType.set(entry.metricType, [entry.metricName])
		}
		return [...byType.entries()].sort(([a], [b]) => a.localeCompare(b))
	}, [entries])

	return useQuery({
		queryKey: [
			"local",
			"metrics",
			"sparklines",
			groups,
			window.bucketSeconds,
			projectKey(scope),
			boundsKey(bounds),
		],
		placeholderData: scopedPlaceholder(scope),
		queryFn: scopedQueryFn(
			scope,
			groups.length > 0 &&
				(async ({ signal }): Promise<ReadonlyMap<string, SparklinePoint[]>> => {
					const params = { ...localParams(bounds), bucketSeconds: window.bucketSeconds }
					const results = await Promise.all(
						groups.flatMap(([metricType, metricNames]) =>
							isMetricType(metricType)
								? [
										executeLocalCompiledQuery(
											CH.compile(
												CH.metricsSparklinesQuery({
													metricType,
													metricNames,
													services: scope.services,
												}),
												params,
											),
											signal,
										),
									]
								: [],
						),
					)
					const points = new Map<string, SparklinePoint[]>()
					for (const row of results.flat()) {
						const point = {
							bucket: row.bucket,
							avgValue: Number(row.avgValue),
							sumValue: Number(row.sumValue),
							dataPointCount: Number(row.dataPointCount),
						}
						const list = points.get(row.metricName)
						if (list) list.push(point)
						else points.set(row.metricName, [point])
					}
					return points
				}),
		),
	})
}
