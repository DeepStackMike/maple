// The numbers on the service map's cards, edges and footer.
//
// Everything here is a pure function of rows the map already fetched, kept out
// of the components because a rate that is wrong by a factor of sixty is not
// visible in a screenshot — it is only visible in a test.

/** A per-second rate. `seconds` of zero or less has no rate, not an infinite one. */
export function perSecond(count: number, seconds: number): number {
	if (!Number.isFinite(count) || !Number.isFinite(seconds) || seconds <= 0) return 0
	return count / seconds
}

/**
 * A rate for a stat column: two significant-ish digits, compacted at a thousand.
 *
 * Lowercase `k`/`M` rather than `formatNumber`'s uppercase: these sit under a
 * `REQ/S` caption in 9 px type, where `12.4K` reads as a constant and `12.4k`
 * reads as a quantity. Below 1/s the precision goes up instead of down — the
 * difference between a service called twice a minute and one called once an
 * hour is the whole content of the column.
 */
export function formatRate(rate: number): string {
	if (!Number.isFinite(rate) || rate <= 0) return "0"
	if (rate >= 1_000_000) return `${(rate / 1_000_000).toFixed(1)}M`
	if (rate >= 1_000) return `${(rate / 1_000).toFixed(1)}k`
	if (rate >= 100) return Math.round(rate).toString()
	if (rate >= 1) return rate.toFixed(1)
	if (rate >= 0.01) return rate.toFixed(2)
	return "<0.01"
}

/** The same rate with its unit, for an edge label: `2.8k req/s`. */
export function formatRateLabel(rate: number, unit = "req"): string {
	return `${formatRate(rate)} ${unit}/s`
}

export interface InsightCandidate {
	readonly label: string
	readonly kind: "service" | "database"
	/** p95 over the window on screen. */
	readonly p95Ms: number
	/** p95 over the window immediately before it, or `null` when it was not read. */
	readonly previousP95Ms: number | null
	/** Volume in the current window — the tie-break, and the noise floor. */
	readonly spanCount: number
}

export interface ServiceMapInsight {
	readonly label: string
	/** Signed fraction: `0.18` is "18% slower than the window before". */
	readonly deltaRatio: number
}

export interface SelectInsightOptions {
	/** Below this many calls a p95 is two requests and a coincidence. */
	readonly minSpanCount?: number
	/** Below this much movement there is nothing to report. */
	readonly minDeltaRatio?: number
}

/**
 * The one thing worth saying about this window: whichever service's p95 moved
 * furthest from the previous window of the same length.
 *
 * Services only. A database node's p95 falls back to the slowest call in the
 * window when the rollup has no digest to merge, and a max compared against a
 * max moves by tens of percent on its own.
 */
export function selectInsight(
	candidates: readonly InsightCandidate[],
	options: SelectInsightOptions = {},
): ServiceMapInsight | null {
	const minSpanCount = options.minSpanCount ?? 20
	const minDeltaRatio = options.minDeltaRatio ?? 0.05

	let best: ServiceMapInsight | null = null
	let bestCount = 0
	for (const candidate of candidates) {
		if (candidate.kind !== "service") continue
		if (candidate.spanCount < minSpanCount) continue
		const previous = candidate.previousP95Ms
		if (previous === null || !Number.isFinite(previous) || previous <= 0) continue
		if (!Number.isFinite(candidate.p95Ms) || candidate.p95Ms <= 0) continue
		const deltaRatio = (candidate.p95Ms - previous) / previous
		if (Math.abs(deltaRatio) < minDeltaRatio) continue
		// Ties go to the busier service, then to the name — the footer must not
		// flip between two equally-moved services on every refetch.
		const better =
			best === null ||
			Math.abs(deltaRatio) > Math.abs(best.deltaRatio) ||
			(Math.abs(deltaRatio) === Math.abs(best.deltaRatio) &&
				(candidate.spanCount > bestCount ||
					(candidate.spanCount === bestCount && candidate.label < best.label)))
		if (better) {
			best = { label: candidate.label, deltaRatio }
			bestCount = candidate.spanCount
		}
	}
	return best
}

/** `PRICING-SVC · P95 +18% VS 1H AGO`. */
export function formatInsight(insight: ServiceMapInsight, windowLabel: string): string {
	const pct = Math.round(insight.deltaRatio * 100)
	// A movement that passed `minDeltaRatio` but rounds to zero percent still has
	// a direction; showing "+0%" is better than showing a number with no sign.
	const sign = insight.deltaRatio >= 0 ? "+" : "−"
	return `${insight.label.toUpperCase()} · P95 ${sign}${Math.abs(pct)}% VS ${windowLabel} AGO`
}
