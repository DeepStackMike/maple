// Derived shapes for the Home overview.
//
// Home asks the same builders the individual tabs ask and joins their answers
// in the browser, so every number on it is reconcilable with the tab it links
// to. The joining arithmetic lives here rather than in the view: it is pure,
// and the parts that are approximations (a merged p95, a bucket-grain "last
// seen") are exactly the parts worth pinning down in a test.
//
// Every input is the minimal structural shape the arithmetic reads, not the
// hook's row type — these functions have no business knowing which query
// produced the row.

/** The per-service columns the KPI strip and the services table both sum over. */
export interface ServiceVolume {
	readonly serviceName: string
	readonly spanCount: number
	readonly errorCount: number
	readonly p95LatencyMs: number
}

export interface OverviewTotals {
	readonly serviceCount: number
	readonly spanCount: number
	readonly errorCount: number
	/** `errorCount / spanCount`, or 0 when the window is empty. */
	readonly errorRate: number
	/** Span-weighted mean of the per-service p95. See {@link summarizeServices}. */
	readonly p95LatencyMs: number
}

const EMPTY_TOTALS: OverviewTotals = {
	serviceCount: 0,
	spanCount: 0,
	errorCount: 0,
	errorRate: 0,
	p95LatencyMs: 0,
}

/**
 * Collapse the service catalog into the KPI strip's six numbers.
 *
 * `p95LatencyMs` is a span-weighted MEAN of the per-service p95s, which is not
 * itself a p95 — the t-digest states that would merge correctly are aggregated
 * away by `serviceCatalogQuery` before the row reaches us. It is the same
 * approximation `useLocalServiceOverview` already makes when it collapses a
 * service's (namespace, env, commit) slices, and it is right for the common
 * local case of one service; weighting it by spans at least keeps a chatty
 * service from being averaged away by a quiet slow one. Anything better needs a
 * builder that merges the digests across services, which is a query-engine
 * change rather than an arithmetic one.
 */
export function summarizeServices(entries: ReadonlyArray<ServiceVolume>): OverviewTotals {
	if (entries.length === 0) return EMPTY_TOTALS

	let spanCount = 0
	let errorCount = 0
	let weightedP95 = 0
	for (const entry of entries) {
		spanCount += entry.spanCount
		errorCount += entry.errorCount
		weightedP95 += entry.p95LatencyMs * entry.spanCount
	}

	return {
		serviceCount: entries.length,
		spanCount,
		errorCount,
		errorRate: spanCount > 0 ? errorCount / spanCount : 0,
		p95LatencyMs: spanCount > 0 ? weightedP95 / spanCount : 0,
	}
}

/** One (bucket, service) cell of the service-overview rollup timeseries. */
export interface OverviewPoint {
	readonly bucket: string
	readonly serviceName: string
	readonly count: number
	/** Fraction of that cell's spans that errored. */
	readonly errorRate: number
}

/** Series keys of the overview chart, and the order the legend reads them in. */
export const OVERVIEW_SERIES = { spans: "Spans", errors: "Errors" } as const

/**
 * A chart row: `bucket` plus one key per series. Typed as the open record the
 * chart component consumes rather than a closed struct — the series names are
 * the legend labels, so they are data, not fields.
 */
export type OverviewSeriesRow = Record<string, unknown> & { bucket: string }

/**
 * Fold the per-service timeseries into the two org-wide series the chart draws.
 *
 * The rollup reports an error RATE per cell, not a count, so errors are
 * recovered as `count * errorRate` and summed — summing the rates themselves
 * would make a quiet service that failed once outweigh a busy one that didn't.
 * Buckets come back ordered, but the fold is keyed by bucket and re-sorted so a
 * caller that concatenates two pages still gets a monotonic x axis.
 */
export function overviewSeries(points: ReadonlyArray<OverviewPoint>): OverviewSeriesRow[] {
	const byBucket = new Map<string, { spans: number; errors: number }>()
	for (const point of points) {
		const totals = byBucket.get(point.bucket) ?? { spans: 0, errors: 0 }
		totals.spans += point.count
		totals.errors += point.count * point.errorRate
		byBucket.set(point.bucket, totals)
	}

	return [...byBucket.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([bucket, totals]) => ({
			bucket,
			[OVERVIEW_SERIES.spans]: totals.spans,
			[OVERVIEW_SERIES.errors]: Math.round(totals.errors),
		}))
}

/**
 * Latest bucket that carried traffic, per service.
 *
 * Resolution is the chart's bucket, not the span — the overview rollup is
 * minute-grain at best and the timeseries is already bucketed to ~60 points
 * across the range, so this reads "within the last N minutes" rather than an
 * exact instant. That is the cost of getting the column out of a query the page
 * already runs instead of a per-service liveness probe (`serviceLivenessQuery`
 * is exact, but it takes one `serviceName` per call).
 *
 * Buckets with no spans are skipped: a rollup row can exist for a cell whose
 * only contribution was dropped by the sample-weighted count.
 */
export function lastSeenByService(points: ReadonlyArray<OverviewPoint>): ReadonlyMap<string, string> {
	const lastSeen = new Map<string, string>()
	for (const point of points) {
		if (point.count <= 0) continue
		const current = lastSeen.get(point.serviceName)
		if (current === undefined || current < point.bucket) lastSeen.set(point.serviceName, point.bucket)
	}
	return lastSeen
}
