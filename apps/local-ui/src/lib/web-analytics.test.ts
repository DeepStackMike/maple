import { describe, expect, it } from "vitest"
import { WEB_ANALYTICS_UNSET } from "@maple/query-engine/ch"
import {
	DEFAULT_ANALYTICS_SECTION,
	TRAFFIC_SERIES,
	bounceRate,
	groupFacets,
	hasVisitorCoverage,
	referrerLabel,
	resolveAnalyticsSection,
	totalPageViews,
	trafficSeries,
	utmLabel,
	withShares,
} from "./web-analytics"

describe("section resolution", () => {
	it("takes an explicit section", () => {
		expect(resolveAnalyticsSection("web", false)).toBe("web")
		expect(resolveAnalyticsSection("product", false)).toBe("product")
	})

	it("falls back to the default for an unset or hand-edited value", () => {
		expect(resolveAnalyticsSection(null, false)).toBe(DEFAULT_ANALYTICS_SECTION)
		expect(resolveAnalyticsSection("", false)).toBe(DEFAULT_ANALYTICS_SECTION)
		expect(resolveAnalyticsSection("funnels", false)).toBe(DEFAULT_ANALYTICS_SECTION)
	})

	// A funnel or an opened event minted before the switcher existed has no
	// `section`, and landing it on Web would hide the thing the link addressed.
	it("infers Product from product-only state", () => {
		expect(resolveAnalyticsSection(null, true)).toBe("product")
	})

	// …but only as a fallback: an explicit choice is a choice.
	it("lets an explicit section override the inference", () => {
		expect(resolveAnalyticsSection("web", true)).toBe("web")
	})
})

describe("bounce rate", () => {
	it("divides by the identified sessions, not by every session", () => {
		expect(bounceRate({ bouncedSessions: 3, identifiedSessions: 12 })).toBeCloseTo(0.25)
	})

	// The Local case: the browser SDK runs with `persistVisitorId: false`, so
	// `VisitorId` is empty on every row and the ratio is 0/0. Unknown, not 0% —
	// a confident zero beside a populated page-views tile reads as "nobody
	// bounced", which is a claim the data cannot support.
	it("is unknown rather than zero with no identified sessions", () => {
		expect(bounceRate({ bouncedSessions: 0, identifiedSessions: 0 })).toBeNull()
	})

	// `bouncedSessions` is a difference of two `uniq` estimates, so it can
	// overshoot its own denominator by a row or two on a big window.
	it("clamps an over-counted numerator to 100%", () => {
		expect(bounceRate({ bouncedSessions: 11, identifiedSessions: 10 })).toBe(1)
	})

	it("reports visitor coverage on the same population as the bounce denominator", () => {
		expect(hasVisitorCoverage({ identifiedSessions: 0 })).toBe(false)
		expect(hasVisitorCoverage({ identifiedSessions: 1 })).toBe(true)
	})
})

describe("traffic series", () => {
	const sessions = [
		{ bucket: "2026-09-16 10:00:00", sessions: 2 },
		{ bucket: "2026-09-16 11:00:00", sessions: 5 },
	]
	const pageViews = [
		{ bucket: "2026-09-16 11:00:00", pageViews: 9 },
		{ bucket: "2026-09-16 12:00:00", pageViews: 4 },
	]

	// The two tables are bucketed on different columns, so neither bucket set
	// contains the other. Both series are counts, so a bucket one table never
	// reported is a zero on the axis rather than a break in the line.
	it("unions the two bucket sets and fills the gaps with zero", () => {
		expect(trafficSeries(sessions, pageViews)).toEqual([
			{
				bucket: "2026-09-16 10:00:00",
				[TRAFFIC_SERIES.sessions]: 2,
				[TRAFFIC_SERIES.pageViews]: 0,
			},
			{
				bucket: "2026-09-16 11:00:00",
				[TRAFFIC_SERIES.sessions]: 5,
				[TRAFFIC_SERIES.pageViews]: 9,
			},
			{
				bucket: "2026-09-16 12:00:00",
				[TRAFFIC_SERIES.sessions]: 0,
				[TRAFFIC_SERIES.pageViews]: 4,
			},
		])
	})

	it("sorts by bucket regardless of the order the rows arrived in", () => {
		const rows = trafficSeries([...sessions].reverse(), [...pageViews].reverse())
		expect(rows.map((row) => row.bucket)).toEqual([
			"2026-09-16 10:00:00",
			"2026-09-16 11:00:00",
			"2026-09-16 12:00:00",
		])
	})

	it("is empty when neither table reported anything", () => {
		expect(trafficSeries([], [])).toEqual([])
	})

	it("sums page views across the buckets", () => {
		expect(totalPageViews(pageViews)).toBe(13)
		expect(totalPageViews([])).toBe(0)
	})
})

describe("breakdown shares", () => {
	it("ranks by count and shares of the listed total", () => {
		const rows = withShares([
			{ name: "Safari", count: 1 },
			{ name: "Chrome", count: 3 },
		])
		expect(rows.map((row) => row.name)).toEqual(["Chrome", "Safari"])
		expect(rows[0]!.share).toBeCloseTo(0.75)
		expect(rows[1]!.share).toBeCloseTo(0.25)
	})

	// Every branch returns a top-N and most of them drop the rows that never
	// populated the column, so the listed total is the only denominator a reader
	// can check by adding the column up.
	it("shares sum to one over whatever the card lists", () => {
		const rows = withShares([
			{ name: "a", count: 5 },
			{ name: "b", count: 3 },
			{ name: "c", count: 2 },
		])
		expect(rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1)
	})

	it("gives a zero share rather than a NaN when nothing was counted", () => {
		expect(withShares([{ name: "a", count: 0 }])).toEqual([{ name: "a", count: 0, share: 0 }])
		expect(withShares([])).toEqual([])
	})

	it("splits the union response by facet type", () => {
		const grouped = groupFacets([
			{ name: "Chrome", count: 4, facetType: "browserName" },
			{ name: "US", count: 2, facetType: "country" },
			{ name: "Safari", count: 1, facetType: "browserName" },
		])
		expect(grouped.get("browserName")).toEqual([
			{ name: "Chrome", count: 4, facetType: "browserName" },
			{ name: "Safari", count: 1, facetType: "browserName" },
		])
		// A dimension nobody reports is absent, which the cards render as empty.
		expect(grouped.get("osName")).toBeUndefined()
	})
})

describe("dimension labels", () => {
	it("names the empty acquisition groups the way every analytics product does", () => {
		expect(referrerLabel(WEB_ANALYTICS_UNSET)).toBe("Direct")
		expect(referrerLabel("news.ycombinator.com")).toBe("news.ycombinator.com")
		expect(utmLabel(WEB_ANALYTICS_UNSET)).toBe("Not set")
		expect(utmLabel("launch-week")).toBe("launch-week")
	})
})
