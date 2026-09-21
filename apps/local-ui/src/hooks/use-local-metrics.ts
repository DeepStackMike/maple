import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { boundsForRange, rangeWindowSeconds } from "../lib/time"

export interface MetricsFilters {
	/** Exact service name match. */
	service?: string
	/** Exact metric type (sum | gauge | histogram | exponential_histogram). */
	type?: string
	/** Substring match on the metric name (toolbar search). */
	search?: string
	/** Time-range preset key (see `TIME_RANGES`). */
	range?: string
}

/** One metric across all reporting services, aggregated from the catalog rows. */
export interface MetricEntry {
	metricName: string
	metricType: string
	metricUnit: string
	metricDescription: string
	serviceNames: string[]
	dataPointCount: number
	lastSeen: string
	isMonotonic: boolean
}

export interface MetricsListData {
	/** Entries matching every filter (including service). */
	entries: MetricEntry[]
	/** Service facet counts (distinct matching metrics per service), pre-service-filter. */
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

/**
 * Metrics catalog list. The service filter is applied client-side over the
 * (small, hourly-rolled-up) catalog result so the same query also yields the
 * service facet counts — mirrors the web app's browse behavior without a
 * second facet query per keystroke.
 */
export function useLocalMetricsList(filters: MetricsFilters) {
	return useQuery({
		queryKey: ["local", "metrics", "list", filters],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<MetricsListData> => {
			const { startTime, endTime } = boundsForRange(filters.range)
			const compiled = CH.compile(
				CH.listMetricsQuery({
					metricType: filters.type,
					search: filters.search,
					limit: 500,
				}),
				{ orgId: LOCAL_ORG_ID, startTime, endTime },
			)
			const rows = await executeLocalCompiledQuery(compiled)

			const byMetric = new Map<string, MetricEntry>()
			const byService = new Map<string, Set<string>>()
			for (const row of rows) {
				const key = `${row.metricName}\x00${row.metricType}`
				const existing = byMetric.get(key)
				if (existing) {
					if (!existing.serviceNames.includes(row.serviceName)) {
						existing.serviceNames.push(row.serviceName)
					}
					existing.dataPointCount += Number(row.dataPointCount)
					if (row.lastSeen > existing.lastSeen) existing.lastSeen = row.lastSeen
				} else {
					byMetric.set(key, {
						metricName: row.metricName,
						metricType: row.metricType,
						metricUnit: row.metricUnit,
						metricDescription: row.metricDescription,
						serviceNames: [row.serviceName],
						dataPointCount: Number(row.dataPointCount),
						lastSeen: row.lastSeen,
						isMonotonic: Number(row.isMonotonic) === 1,
					})
				}
				let metricsOfService = byService.get(row.serviceName)
				if (!metricsOfService) byService.set(row.serviceName, (metricsOfService = new Set()))
				metricsOfService.add(key)
			}

			const all = [...byMetric.values()]
			const entries = filters.service
				? all.filter((e) => e.serviceNames.includes(filters.service!))
				: all
			const serviceFacets = [...byService.entries()]
				.map(([name, metrics]) => ({ name, count: metrics.size }))
				.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

			return { entries, serviceFacets }
		},
	})
}

export interface MetricsSummaryRow {
	metricType: string
	metricCount: number
	dataPointCount: number
}

/** Per-type metric/datapoint counts for the summary stats + type facet. */
export function useLocalMetricsSummary(filters: Pick<MetricsFilters, "service" | "range">) {
	return useQuery({
		queryKey: ["local", "metrics", "summary", filters],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<MetricsSummaryRow>> => {
			const { startTime, endTime } = boundsForRange(filters.range)
			const compiled = CH.compile(CH.metricsSummaryQuery({ serviceName: filters.service }), {
				orgId: LOCAL_ORG_ID,
				startTime,
				endTime,
			})
			const rows = await executeLocalCompiledQuery(compiled)
			return rows.map((r) => ({
				metricType: r.metricType,
				metricCount: Number(r.metricCount),
				dataPointCount: Number(r.dataPointCount),
			}))
		},
	})
}

export interface SparklinePoint {
	bucket: string
	avgValue: number
	sumValue: number
	dataPointCount: number
}

/**
 * Batched preview series for the visible grid — one query per metric type
 * (mirrors the web app's browse: counters preview datapoints/interval, the
 * true rate needs the window CTE which must not run one-per-card).
 */
export function useLocalMetricsSparklines(entries: ReadonlyArray<MetricEntry>, range: string | undefined) {
	const byType = new Map<string, string[]>()
	for (const entry of entries) {
		const names = byType.get(entry.metricType)
		if (names) names.push(entry.metricName)
		else byType.set(entry.metricType, [entry.metricName])
	}
	const groups = [...byType.entries()].sort(([a], [b]) => a.localeCompare(b))

	return useQuery({
		queryKey: ["local", "metrics", "sparklines", groups, range],
		enabled: entries.length > 0,
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyMap<string, SparklinePoint[]>> => {
			const { startTime, endTime } = boundsForRange(range)
			const bucketSeconds = bucketSecondsForRange(range)
			const results = await Promise.all(
				groups.map(([metricType, metricNames]) =>
					executeLocalCompiledQuery(
						CH.compile(
							CH.metricsSparklinesQuery({
								metricType: metricType as CH.MetricsSparklinesOpts["metricType"],
								metricNames,
							}),
							{ orgId: LOCAL_ORG_ID, startTime, endTime, bucketSeconds },
						),
					),
				),
			)
			const points = new Map<string, SparklinePoint[]>()
			for (const rows of results) {
				for (const row of rows) {
					const list = points.get(row.metricName)
					const point = {
						bucket: row.bucket,
						avgValue: Number(row.avgValue),
						sumValue: Number(row.sumValue),
						dataPointCount: Number(row.dataPointCount),
					}
					if (list) list.push(point)
					else points.set(row.metricName, [point])
				}
			}
			return points
		},
	})
}
