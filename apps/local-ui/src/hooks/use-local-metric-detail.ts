import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query"
import { HARD_SERIES_LIMIT } from "@maple/ui/components/plot"
import { CH } from "@maple/query-engine"
import { boundsKey, executeLocalCompiledQuery, localParams } from "@/lib/query"
import type { SeriesPoint } from "../lib/chart-series"
import { DEFAULT_SERIES_LIMIT, GROUP_BY_SERVICE, type MetricFilter } from "../lib/metric-explorer"
import type { ChartWindow, TimeBounds } from "../lib/time"
import { isCounter, isMetricType, type MetricType } from "../lib/units"
import { foldCatalogRows, type MetricEntry } from "./use-local-metrics"
import {
	projectKey,
	scopedPlaceholder,
	scopedQueryFn,
	type ProjectScope,
	type ProjectServices,
} from "../lib/project-scope"

/**
 * The header scope a metric's own page runs under: the project (as its
 * services) and the environment. Unlike the list, the series here are read
 * from the metric tables, which carry the environment in the resource map.
 */
export interface MetricScope {
	readonly project: ProjectScope
	readonly environment: string | undefined
}

/** A scope as the metric builders spell it (`services`, `environments`). */
export interface MetricScopeFilter {
	readonly services?: ProjectServices
	readonly environments?: ReadonlyArray<string>
}

export function metricScopeFilter(scope: MetricScope): MetricScopeFilter {
	return {
		services: scope.project.services,
		environments: scope.environment ? [scope.environment] : undefined,
	}
}

/**
 * Catalog row(s) for one metric, aggregated across the header project's
 * services (all of them with no project). The catalog has no environment, so
 * the entry is the same in every one; the series below are not.
 */
export function useLocalMetricEntry(metricName: string, bounds: TimeBounds, project: ProjectScope) {
	return useQuery({
		queryKey: ["local", "metrics", "entry", metricName, projectKey(project), boundsKey(bounds)],
		placeholderData: scopedPlaceholder(project),
		queryFn: scopedQueryFn(project, async ({ signal }): Promise<MetricEntry | null> => {
			const compiled = CH.compile(
				CH.listMetricsQuery({ search: metricName, services: project.services, limit: 50 }),
				localParams(bounds),
			)
			const rows = (await executeLocalCompiledQuery(compiled, signal)).filter(
				(r) => r.metricName === metricName,
			)
			return foldCatalogRows(rows).entries[0] ?? null
		}),
	})
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
	opts: {
		metricName: string
		bucketSeconds: number
		options: MetricExplorerOptions
		scope?: MetricScopeFilter
	},
	params: Parameters<typeof CH.compile>[1],
) =>
	CH.compile(
		CH.metricsTimeseriesRateQuery({
			metricName: opts.metricName,
			bucketSeconds: opts.bucketSeconds,
			...seriesOptionsFor(opts.options),
			...opts.scope,
		}),
		params,
	)

export const compileMetricValueTimeseriesQuery = (
	opts: { metricType: MetricType; options: MetricExplorerOptions; scope?: MetricScopeFilter },
	params: Parameters<typeof CH.compile>[1],
) =>
	CH.compile(
		CH.metricsTimeseriesQuery({
			metricType: opts.metricType,
			...seriesOptionsFor(opts.options),
			...opts.scope,
		}),
		params,
	)

/**
/**
 * One raw timeseries row before series are merged: a (bucket, group) value and
 * the datapoints behind it — the weight when two rows share a series.
 */
interface WeightedPoint {
	bucket: string
	series: string
	value: number
	count: number
}

/**
 * Collapse rows that land on the same (bucket, series).
 *
 * The query groups by service *and* the chosen dimension, so grouping by an
 * attribute returns one row per service per value and a bucket can hit the
 * same series twice. Rates add across services; averages are recombined as a
 * datapoint-weighted mean, which is the same number the ungrouped query would
 * have produced. Datapoints missing the group-by label share one named series
 * rather than an unlabelled one the legend can't explain.
 */
export function mergeSeriesPoints(
	rows: ReadonlyArray<WeightedPoint>,
	additive: boolean,
	missingLabel: string,
): SeriesPoint[] {
	const merged = new Map<string, WeightedPoint>()
	for (const row of rows) {
		const series = row.series || missingLabel
		const key = `${row.bucket}\x00${series}`
		const existing = merged.get(key)
		if (!existing) {
			merged.set(key, { ...row, series })
		} else if (additive) {
			existing.value += row.value
			existing.count += row.count
		} else {
			const weight = existing.count + row.count
			if (weight > 0)
				existing.value = (existing.value * existing.count + row.value * row.count) / weight
			existing.count = weight
		}
	}
	return [...merged.values()].map(({ bucket, series, value }) => ({ bucket, series, value }))
}

/**
 * Detail timeseries, one series per group-by value. Counters plot the true
 * per-second rate (window-CTE query); everything else plots the average value.
 */
export function useLocalMetricTimeseries(
	entry: MetricEntry | null | undefined,
	bounds: TimeBounds,
	window: ChartWindow,
	options: MetricExplorerOptions,
	scope: MetricScope,
) {
	const filter = metricScopeFilter(scope)
	// Grouped by service there is one row per (bucket, service) and no label is
	// ever missing, so the merge only renames; keep upstream's "value" fallback.
	const missingLabel = options.groupBy === GROUP_BY_SERVICE ? "value" : "(none)"
	return useQuery({
		queryKey: [
			"local",
			"metrics",
			"timeseries",
			entry?.metricName,
			entry?.metricType,
			entry?.isMonotonic,
			window.bucketSeconds,
			boundsKey(bounds),
			options,
			projectKey(scope.project),
			scope.environment ?? null,
		],
		placeholderData: scopedPlaceholder(scope.project),
		queryFn: scopedQueryFn(
			scope.project,
			!!entry &&
				(async ({ signal }): Promise<ReadonlyArray<SeriesPoint>> => {
					const { bucketSeconds } = window
					const params = { ...localParams(bounds), bucketSeconds, metricName: entry.metricName }
					if (isCounter(entry)) {
						const rows = await executeLocalCompiledQuery(
							compileMetricRateTimeseriesQuery(
								{ metricName: entry.metricName, bucketSeconds, options, scope: filter },
								params,
							),
							signal,
						)
						return mergeSeriesPoints(
							rows.map((r) => ({
								bucket: r.bucket,
								series: r.groupName,
								value: Number(r.rateValue),
								count: Number(r.dataPointCount),
							})),
							true,
							missingLabel,
						)
					}
					const metricType = entry.metricType
					if (!isMetricType(metricType)) return []
					const rows = await executeLocalCompiledQuery(
						compileMetricValueTimeseriesQuery({ metricType, options, scope: filter }, params),
						signal,
					)
					return mergeSeriesPoints(
						rows.map((r) => ({
							bucket: r.bucket,
							series: r.groupName,
							value: Number(r.avgValue),
							count: Number(r.dataPointCount),
						})),
						false,
						missingLabel,
					)
				}),
		),
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
	bounds: TimeBounds,
	options: MetricExplorerOptions,
	scope: MetricScope,
) {
	const metricType = entry?.metricType
	const filter = metricScopeFilter(scope)
	return useQuery({
		queryKey: [
			"local",
			"metrics",
			"breakdown",
			entry?.metricName,
			metricType,
			boundsKey(bounds),
			options,
			projectKey(scope.project),
			scope.environment ?? null,
		],
		placeholderData: scopedPlaceholder(scope.project),
		queryFn: scopedQueryFn(
			scope.project,
			!!entry &&
				!!metricType &&
				isMetricType(metricType) &&
				(async ({ signal }): Promise<ReadonlyArray<MetricBreakdownRow>> => {
					const rows = await executeLocalCompiledQuery(
						CH.compile(
							CH.metricsBreakdownQuery({
								metricType,
								groupByAttributeKey:
									options.groupBy === GROUP_BY_SERVICE ? undefined : options.groupBy,
								attributeFilters: options.filters,
								limit: options.seriesLimit,
								...filter,
							}),
							{ ...localParams(bounds), metricName: entry.metricName },
						),
						signal,
					)
					return rows.map((r) => ({
						name: r.name,
						avgValue: Number(r.avgValue),
						sumValue: Number(r.sumValue),
						count: Number(r.count),
					}))
				}),
		),
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
export function useLocalMetricAttributeKeys(entry: MetricEntry | null | undefined, bounds: TimeBounds) {
	const metricType = entry?.metricType
	return useQuery({
		queryKey: ["local", "metrics", "attribute-keys", entry?.metricName, metricType, boundsKey(bounds)],
		placeholderData: keepPreviousData,
		queryFn:
			entry && metricType && isMetricType(metricType)
				? async ({ signal }): Promise<ReadonlyArray<MetricAttributeFacet>> => {
						const rows = await executeLocalCompiledQuery(
							CH.compile(CH.metricScopedAttributeKeysQuery({ metricType, limit: 100 }), {
								...localParams(bounds),
								metricName: entry.metricName,
							}),
							signal,
						)
						return rows.map((r) => ({ name: r.attributeKey, count: Number(r.usageCount) }))
					}
				: skipToken,
	})
}

/** Values seen for one of this metric's attribute keys — the filter row's suggestions. */
export function useLocalMetricAttributeValues(
	entry: MetricEntry | null | undefined,
	bounds: TimeBounds,
	attributeKey: string | undefined,
) {
	const metricType = entry?.metricType
	return useQuery({
		queryKey: [
			"local",
			"metrics",
			"attribute-values",
			entry?.metricName,
			metricType,
			attributeKey,
			boundsKey(bounds),
		],
		placeholderData: keepPreviousData,
		queryFn:
			entry && metricType && isMetricType(metricType) && attributeKey
				? async ({ signal }): Promise<ReadonlyArray<MetricAttributeFacet>> => {
						const rows = await executeLocalCompiledQuery(
							CH.compile(
								CH.metricScopedAttributeValuesQuery({ metricType, attributeKey, limit: 50 }),
								{ ...localParams(bounds), metricName: entry.metricName },
							),
							signal,
						)
						return rows.map((r) => ({ name: r.attributeValue, count: Number(r.usageCount) }))
					}
				: skipToken,
	})
}
