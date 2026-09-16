// URL state for the metric explorer's group-by / series-limit / filter controls.
//
// The detail view keeps all three in the hash query params so a chart is a
// link, which makes the wire format part of the contract: this module is the
// only place that knows it, and it is pure so the round-trip is testable.

/** One `Attributes[key] = value` predicate on a metric's datapoints. */
export interface MetricFilter {
	readonly key: string
	readonly value: string
}

/** The group-by dimension that means "one series per service" (the default). */
export const GROUP_BY_SERVICE = "service"

/** Series-limit presets offered by the toolbar. */
export const SERIES_LIMIT_OPTIONS = [5, 10, 20] as const

export const DEFAULT_SERIES_LIMIT = 10

/**
 * `key:value` pairs joined by `,`, each half percent-encoded so a value
 * containing `:` or `,` survives. `URLSearchParams` encodes the result a second
 * time on the way into the hash and decodes that layer on the way out, so the
 * two encodings compose rather than collide.
 */
export function encodeMetricFilters(filters: ReadonlyArray<MetricFilter>): string {
	return filters
		.filter((f) => f.key !== "")
		.map((f) => `${encodeURIComponent(f.key)}:${encodeURIComponent(f.value)}`)
		.join(",")
}

/**
 * Inverse of `encodeMetricFilters`. A hand-edited URL is untrusted input:
 * pairs with no separator, an empty key, or an undecodable escape are dropped
 * rather than thrown on, so one bad pair can't blank the whole view.
 */
export function decodeMetricFilters(raw: string | null | undefined): MetricFilter[] {
	if (!raw) return []
	const seen = new Set<string>()
	const filters: MetricFilter[] = []
	for (const pair of raw.split(",")) {
		const separator = pair.indexOf(":")
		if (separator <= 0) continue
		let key: string
		let value: string
		try {
			key = decodeURIComponent(pair.slice(0, separator))
			value = decodeURIComponent(pair.slice(separator + 1))
		} catch {
			continue
		}
		if (key === "") continue
		const dedupeKey = `${key}\x00${value}`
		if (seen.has(dedupeKey)) continue
		seen.add(dedupeKey)
		filters.push({ key, value })
	}
	return filters
}

/** Clamps a URL-supplied series limit to one of the presets. */
export function parseSeriesLimit(raw: string | null | undefined): number {
	const parsed = Number(raw)
	return (SERIES_LIMIT_OPTIONS as ReadonlyArray<number>).includes(parsed) ? parsed : DEFAULT_SERIES_LIMIT
}
