import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Option } from "effect"
import { HARD_SERIES_LIMIT } from "@maple/ui/components/plot"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { DEFAULT_SERIES_LIMIT, GROUP_BY_SERVICE, type MetricFilter } from "../lib/metric-explorer"
import { boundsForRange } from "../lib/time"
import { bucketSecondsForRange, type MetricEntry } from "./use-local-metrics"

/** Catalog row(s) for one metric, aggregated across services. */
export function useLocalMetricEntry(metricName: string, range: string | undefined) {
	return useQuery({
		queryKey: ["local", "metrics", "entry", metricName, range],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<MetricEntry | null> => {
			const { startTime, endTime } = boundsForRange(range)
			const compiled = CH.compile(CH.listMetricsQuery({ search: metricName, limit: 50 }), {
				orgId: LOCAL_ORG_ID,
				startTime,
				endTime,
			})
			const rows = (await executeLocalCompiledQuery(compiled)).filter(
				(r) => r.metricName === metricName,
			)
			if (rows.length === 0) return null
			const first = rows[0]!
			return {
				metricName,
				metricType: first.metricType,
				metricUnit: first.metricUnit,
				metricDescription: first.metricDescription,
				serviceNames: [...new Set(rows.map((r) => r.serviceName))],
				dataPointCount: rows.reduce((sum, r) => sum + Number(r.dataPointCount), 0),
				lastSeen: rows.reduce((max, r) => (r.lastSeen > max ? r.lastSeen : max), first.lastSeen),
				isMonotonic: Number(first.isMonotonic) === 1,
			}
		},
	})
}

export interface MetricSeriesPoint {
	bucket: string
	groupName: string
	value: number
	/** Datapoints behind `value` — the weight when two rows share a series. */
	count: number
}

/** What the explorer controls resolve to: one dimension, N series, N filters. */
export interface MetricExplorerOptions {
	/** `GROUP_BY_SERVICE`, or a datapoint attribute key. */
	groupBy: string
	seriesLimit: number
	filters: ReadonlyArray<MetricFilter>
}

export const DEFAULT_EXPLORER_OPTIONS: MetricExplorerOptions = {
	groupBy: GROUP_BY_SERVICE,
	seriesLimit: DEFAULT_SERIES_LIMIT,
	filters: [],
}

/**
 * Explorer controls → query-builder options.
 *
 * The chart draws at most `HARD_SERIES_LIMIT` lines, so the user's series limit
 * is also clamped to it: without a cap in the query, a high-cardinality install
 * fetches and pivots every series only for the chart to drop all but 60.
 * `groupBy` is passed through because the cap only applies to a real group-by.
 */
const seriesOptionsFor = (options: MetricExplorerOptions) => ({
	groupByAttributeKey: options.groupBy === GROUP_BY_SERVICE ? undefined : options.groupBy,
	groupBy: [options.groupBy],
	seriesLimit: Math.min(options.seriesLimit, HARD_SERIES_LIMIT),
	attributeFilters: options.filters,
})

export const compileMetricRateTimeseriesQuery = (
	opts: { metricName: string; bucketSeconds: number; options: MetricExplorerOptions },
	params: Parameters<typeof CH.compile>[1],
) =>
	CH.compile(
		CH.metricsTimeseriesRateQuery({
			metricName: opts.metricName,
			bucketSeconds: opts.bucketSeconds,
			...seriesOptionsFor(opts.options),
		}),
		params,
	)

export const compileMetricValueTimeseriesQuery = (
	opts: { metricType: CH.MetricsTimeseriesOpts["metricType"]; options: MetricExplorerOptions },
	params: Parameters<typeof CH.compile>[1],
) =>
	CH.compile(
		CH.metricsTimeseriesQuery({ metricType: opts.metricType, ...seriesOptionsFor(opts.options) }),
		params,
	)

/**
 * Detail timeseries, one series per group-by value. Monotonic counters plot the
 * true per-second rate (window-CTE query); gauges/histograms plot the average
 * value.
 */
export function useLocalMetricTimeseries(
	entry: MetricEntry | null | undefined,
	range: string | undefined,
	options: MetricExplorerOptions = DEFAULT_EXPLORER_OPTIONS,
) {
	const metricName = entry?.metricName
	const isRate = entry?.metricType === "sum" && entry.isMonotonic
	return useQuery({
		queryKey: ["local", "metrics", "timeseries", metricName, entry?.metricType, isRate, range, options],
		enabled: entry != null,
		placeholderData: keepPreviousData,
		queryFn: (): Promise<ReadonlyArray<MetricSeriesPoint>> =>
			Option.match(Option.fromNullishOr(entry), {
				// Unreachable: `enabled` gates the query on the entry existing.
				onNone: () => Promise.resolve([]),
				onSome: async (metric) => {
					const { startTime, endTime } = boundsForRange(range)
					const bucketSeconds = bucketSecondsForRange(range)
					const params = {
						orgId: LOCAL_ORG_ID,
						startTime,
						endTime,
						bucketSeconds,
						metricName: metric.metricName,
					}
					if (isRate) {
						const rows = await executeLocalCompiledQuery(
							compileMetricRateTimeseriesQuery(
								{ metricName: metric.metricName, bucketSeconds, options },
								params,
							),
						)
						return rows.map((r) => ({
							bucket: r.bucket,
							groupName: r.groupName,
							value: Number(r.rateValue),
							count: Number(r.dataPointCount),
						}))
					}
					const rows = await executeLocalCompiledQuery(
						compileMetricValueTimeseriesQuery(
							{
								metricType: metric.metricType as CH.MetricsTimeseriesOpts["metricType"],
								options,
							},
							params,
						),
					)
					return rows.map((r) => ({
						bucket: r.bucket,
						groupName: r.groupName,
						value: Number(r.avgValue),
						count: Number(r.dataPointCount),
					}))
				},
			}),
	})
}

export interface MetricBreakdownRow {
	name: string
	avgValue: number
	sumValue: number
	count: number
}

/**
 * Breakdown table for the detail page — same dimension and filters as the
 * chart, so the table reads as the chart's totals rather than a second query
 * about a different slice of the data.
 */
export function useLocalMetricBreakdown(
	entry: MetricEntry | null | undefined,
	range: string | undefined,
	options: MetricExplorerOptions = DEFAULT_EXPLORER_OPTIONS,
) {
	const metricName = entry?.metricName
	return useQuery({
		queryKey: ["local", "metrics", "breakdown", metricName, entry?.metricType, range, options],
		enabled: entry != null,
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<MetricBreakdownRow>> => {
			const { startTime, endTime } = boundsForRange(range)
			const rows = await executeLocalCompiledQuery(
				CH.compile(
					CH.metricsBreakdownQuery({
						metricType: entry!.metricType as CH.MetricsBreakdownOpts["metricType"],
						groupByAttributeKey:
							options.groupBy === GROUP_BY_SERVICE ? undefined : options.groupBy,
						attributeFilters: options.filters,
						limit: options.seriesLimit,
					}),
					{ orgId: LOCAL_ORG_ID, startTime, endTime, metricName: metricName! },
				),
			)
			return rows.map((r) => ({
				name: r.name,
				avgValue: Number(r.avgValue),
				sumValue: Number(r.sumValue),
				count: Number(r.count),
			}))
		},
	})
}

export interface MetricAttributeFacet {
	name: string
	count: number
}

/**
 * Datapoint attribute keys this metric actually carries in the selected range,
 * most-used first — the choices for "Group by" and for a filter's key.
 *
 * `attribute_keys_hourly` has no MetricName column (and only materializes from
 * `metrics_sum`), so per-metric discovery reads the metric's own table through
 * `metricScopedAttributeKeysQuery` rather than the rollup.
 */
export function useLocalMetricAttributeKeys(
	entry: MetricEntry | null | undefined,
	range: string | undefined,
) {
	const metricName = entry?.metricName
	const metricType = entry?.metricType
	return useQuery({
		queryKey: ["local", "metrics", "attribute-keys", metricName, metricType, range],
		enabled: entry != null,
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<MetricAttributeFacet>> => {
			const { startTime, endTime } = boundsForRange(range)
			const rows = await executeLocalCompiledQuery(
				CH.compile(
					CH.metricScopedAttributeKeysQuery({
						metricType: metricType as CH.MetricScopedAttributeKeysOpts["metricType"],
						limit: 100,
					}),
					{ orgId: LOCAL_ORG_ID, startTime, endTime, metricName: metricName! },
				),
			)
			return rows.map((r) => ({ name: r.attributeKey, count: Number(r.usageCount) }))
		},
	})
}

/** Values seen for one of this metric's attribute keys — the filter row's suggestions. */
export function useLocalMetricAttributeValues(
	entry: MetricEntry | null | undefined,
	range: string | undefined,
	attributeKey: string | undefined,
) {
	const metricName = entry?.metricName
	const metricType = entry?.metricType
	return useQuery({
		queryKey: ["local", "metrics", "attribute-values", metricName, metricType, attributeKey, range],
		enabled: entry != null && !!attributeKey,
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<MetricAttributeFacet>> => {
			const { startTime, endTime } = boundsForRange(range)
			const rows = await executeLocalCompiledQuery(
				CH.compile(
					CH.metricScopedAttributeValuesQuery({
						metricType: metricType as CH.MetricScopedAttributeValuesOpts["metricType"],
						attributeKey: attributeKey!,
						limit: 50,
					}),
					{ orgId: LOCAL_ORG_ID, startTime, endTime, metricName: metricName! },
				),
			)
			return rows.map((r) => ({ name: r.attributeValue, count: Number(r.usageCount) }))
		},
	})
}
