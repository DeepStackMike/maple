// Derived shapes for the Analytics tab's Web section.
//
// The hooks hand back what the builders return — one summary row, two
// timeseries from two different tables, and a twelve-branch facet union — and
// the panel needs a KPI strip, one chart and nine ranked tables. That folding
// is pure, so it lives here rather than in the component, and the parts that
// are judgement calls (which denominator a share is of, when a visitor metric
// is unknown rather than zero) are the parts worth pinning down in a test.
//
// Every input is the minimal structural shape the arithmetic reads, not the
// hook's row type — same rule as `home-overview.ts`.

import { WEB_ANALYTICS_UNSET } from "@maple/query-engine/ch"

// Sections

/**
 * The tab's two halves. Web is the one a site owner opens Analytics for and the
 * one the cloud `/analytics` route is entirely about; Product (events, funnels)
 * is local mode's addition, reached from the same range select.
 */
export type AnalyticsSection = "web" | "product"

export const ANALYTICS_SECTIONS: ReadonlyArray<{ readonly key: AnalyticsSection; readonly label: string }> = [
	{ key: "web", label: "Web" },
	{ key: "product", label: "Product" },
]

export const DEFAULT_ANALYTICS_SECTION: AnalyticsSection = "web"

/**
 * Which section the hash asks for.
 *
 * An explicit `section` always wins. Absent it, the presence of product-only
 * state (`event`, `steps`) picks Product: those params are how the previous
 * build's links addressed an opened event or a built funnel, and there was no
 * `section` to write when they were minted. Without this, every funnel link
 * already shared would land on Web with its own state invisible.
 */
export function resolveAnalyticsSection(
	raw: string | null | undefined,
	hasProductState: boolean,
): AnalyticsSection {
	const match = ANALYTICS_SECTIONS.find((section) => section.key === raw)
	if (match) return match.key
	return hasProductState ? "product" : DEFAULT_ANALYTICS_SECTION
}

// Summary

/**
 * The fields the KPI strip reads off `webAnalyticsSummaryQuery`, plus the page
 * views it cannot supply (see that query's doc comment on why summing its
 * `PageViews` column is the wrong source) and the error sessions that come from
 * the sessions facet query.
 */
export interface WebSummaryInput {
	readonly sessions: number
	readonly visitors: number
	readonly identifiedSessions: number
	readonly bouncedSessions: number
	readonly avgDurationMs: number
}

/**
 * Bounce rate, or `null` when it is not measurable over this window.
 *
 * The numerator and the denominator are both confined to sessions carrying a
 * `VisitorId` — that is the population that reports `PageViews` at all, and
 * dividing by every session instead reports a session recorded by an older SDK
 * build as a bounce. In Local that population is usually empty: the browser SDK
 * runs with `persistVisitorId: false`, so `VisitorId` is `''` on every row and
 * the ratio is 0/0.
 *
 * `null` rather than 0 because the two are different claims. A confident "0%
 * bounce rate" beside a populated page-views tile is the misreading this exists
 * to prevent; the tile renders `—` and says why.
 */
export function bounceRate(summary: Pick<WebSummaryInput, "bouncedSessions" | "identifiedSessions">) {
	if (summary.identifiedSessions <= 0) return null
	return clampFraction(summary.bouncedSessions / summary.identifiedSessions)
}

/**
 * Whether the visitor-level numbers on this page mean anything.
 *
 * Same test as the bounce denominator, and deliberately the same answer: with
 * no identified session there is no visitor id anywhere in the window, so
 * "unique visitors" is unknown rather than zero.
 */
export function hasVisitorCoverage(summary: Pick<WebSummaryInput, "identifiedSessions">): boolean {
	return summary.identifiedSessions > 0
}

/** Bounded to 0–1: `bouncedSessions` is a difference of two `uniq` estimates. */
function clampFraction(value: number): number {
	if (!Number.isFinite(value)) return 0
	return Math.min(1, Math.max(0, value))
}

// Traffic chart

/** One bucket of `webAnalyticsTimeseriesQuery`, as the chart reads it. */
export interface SessionsPoint {
	readonly bucket: string
	readonly sessions: number
}

/** One bucket of `webAnalyticsPageviewsTimeseriesQuery`. */
export interface PageviewsPoint {
	readonly bucket: string
	readonly pageViews: number
}

/** Series keys of the traffic chart, and the order the legend reads them in. */
export const TRAFFIC_SERIES = { sessions: "Sessions", pageViews: "Page views" } as const

/**
 * A chart row: `bucket` plus one key per series. Open record rather than a
 * closed struct — the series names are the legend labels, so they are data.
 * Same shape the Home overview chart consumes.
 */
export type TrafficRow = Record<string, unknown> & { bucket: string }

/**
 * Fold the two timeseries into the rows the chart draws.
 *
 * They come from different tables bucketed on different columns — sessions from
 * `session_replays.StartTime`, page views from `session_events.Timestamp` — so
 * neither bucket set contains the other: a session that started before the
 * window and was navigated inside it contributes a page view to a bucket with
 * no session, and a session that started in the last bucket may not have landed
 * its navigation row yet. The union is taken and the gaps are filled with 0
 * rather than dropped, because both series are counts: a bucket neither table
 * reports is a bucket in which nothing happened, which is a point on the axis,
 * not a break in the line.
 */
export function trafficSeries(
	sessions: ReadonlyArray<SessionsPoint>,
	pageViews: ReadonlyArray<PageviewsPoint>,
): TrafficRow[] {
	const byBucket = new Map<string, { sessions: number; pageViews: number }>()
	const cell = (bucket: string) => {
		const existing = byBucket.get(bucket)
		if (existing) return existing
		const fresh = { sessions: 0, pageViews: 0 }
		byBucket.set(bucket, fresh)
		return fresh
	}
	for (const point of sessions) cell(point.bucket).sessions += point.sessions
	for (const point of pageViews) cell(point.bucket).pageViews += point.pageViews

	return [...byBucket.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([bucket, totals]) => ({
			bucket,
			[TRAFFIC_SERIES.sessions]: totals.sessions,
			[TRAFFIC_SERIES.pageViews]: totals.pageViews,
		}))
}

/** Total page views in the window — summed from the buckets, the only source that has them. */
export function totalPageViews(points: ReadonlyArray<PageviewsPoint>): number {
	return points.reduce((total, point) => total + point.pageViews, 0)
}

// Breakdowns

/** One row of the facet union, before the share is computed. */
export interface FacetRow {
	readonly name: string
	readonly count: number
	readonly facetType: string
}

/** A ranked row as a breakdown card renders it. */
export interface BreakdownRow {
	readonly name: string
	readonly count: number
	/** Share of the **listed** total — see {@link withShares}. */
	readonly share: number
}

/**
 * Split the one union response into its branches.
 *
 * `webAnalyticsBreakdownsQuery` returns twelve dimensions in one round trip,
 * discriminated by `facetType`; every card on the page reads one key of this
 * map. A dimension nobody reports is absent rather than empty, and the callers
 * treat the two the same way.
 */
export function groupFacets(rows: ReadonlyArray<FacetRow>): ReadonlyMap<string, ReadonlyArray<FacetRow>> {
	const grouped = new Map<string, FacetRow[]>()
	for (const row of rows) {
		const list = grouped.get(row.facetType)
		if (list) list.push(row)
		else grouped.set(row.facetType, [row])
	}
	return grouped
}

/**
 * Rank rows and attach each one's share.
 *
 * The share is of the **listed** total, not of all sessions. Each branch
 * returns a top-N and drops the rows that never populated the column, so the
 * tail is absent from the denominator either way — and a share of "the traffic
 * this dimension can describe" is the one a reader can check by adding the
 * column up. Same rule as the cloud breakdown panel.
 *
 * Sorted here rather than relying on the branch's `ORDER BY`: the rows have
 * been through a union, a JSON round trip and a group-by since then, and a card
 * whose first row is not its largest is worse than a redundant sort.
 */
export function withShares(rows: ReadonlyArray<{ name: string; count: number }>): BreakdownRow[] {
	const total = rows.reduce((sum, row) => sum + row.count, 0)
	return [...rows]
		.sort((a, b) => b.count - a.count)
		.map((row) => ({ name: row.name, count: row.count, share: total > 0 ? row.count / total : 0 }))
}

// Labels

/**
 * The empty-referrer group. "Direct" is what every analytics product calls it,
 * even though the bucket also covers internal navigation and a suppressing
 * `Referrer-Policy` — a longer, truer label would not fit the row.
 */
export function referrerLabel(host: string): string {
	return host === WEB_ANALYTICS_UNSET ? "Direct" : host
}

/** The untagged group of a `utm_*` dimension. */
export function utmLabel(value: string): string {
	return value === WEB_ANALYTICS_UNSET ? "Not set" : value
}

let regionNames: Intl.DisplayNames | undefined | null = null

/**
 * `DE` → `🇩🇪 Germany`, falling back to the raw value for anything that is not a
 * two-letter region code.
 *
 * `Intl.DisplayNames` is the whole implementation: the browser already ships
 * the CLDR region table, and our own map would be a few KB that goes stale.
 * Constructed once, because constructing one per row is the expensive part.
 */
export function countryLabel(code: string): string {
	if (!/^[A-Za-z]{2}$/.test(code)) return code
	const upper = code.toUpperCase()
	if (regionNames === null) {
		try {
			regionNames = new Intl.DisplayNames(undefined, { type: "region", fallback: "none" })
		} catch {
			regionNames = undefined
		}
	}
	const flag = String.fromCodePoint(
		...[...upper].map((char) => 0x1f1e6 + (char.charCodeAt(0) - "A".charCodeAt(0))),
	)
	return `${flag} ${regionNames?.of(upper) ?? upper}`
}
