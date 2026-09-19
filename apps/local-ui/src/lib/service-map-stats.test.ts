import { describe, expect, it } from "vitest"
import {
	formatInsight,
	formatRate,
	formatRateLabel,
	perSecond,
	selectInsight,
	type InsightCandidate,
} from "./service-map-stats"

describe("perSecond", () => {
	it("divides by the window", () => {
		expect(perSecond(600, 60)).toBe(10)
	})

	// The denominator is the window's nominal length, and a view that has not
	// resolved one yet must not produce Infinity in a stat column.
	it("has no rate for a window of zero", () => {
		expect(perSecond(600, 0)).toBe(0)
		expect(perSecond(600, -60)).toBe(0)
	})

	it("has no rate for a count that is not a number", () => {
		expect(perSecond(Number.NaN, 60)).toBe(0)
	})
})

describe("formatRate", () => {
	it("compacts thousands and millions in lowercase", () => {
		expect(formatRate(12_400)).toBe("12.4k")
		expect(formatRate(2_800)).toBe("2.8k")
		expect(formatRate(3_400_000)).toBe("3.4M")
	})

	it("drops the decimal above a hundred", () => {
		expect(formatRate(148.6)).toBe("149")
	})

	it("keeps one decimal in the single and double digits", () => {
		expect(formatRate(8)).toBe("8.0")
		expect(formatRate(12.44)).toBe("12.4")
	})

	// A service called twice a minute and one called once an hour are both "0"
	// at one decimal, and they are not the same service.
	it("gains precision below one per second", () => {
		expect(formatRate(0.033)).toBe("0.03")
		expect(formatRate(0.0004)).toBe("<0.01")
	})

	it("shows nothing as zero, not as a fraction", () => {
		expect(formatRate(0)).toBe("0")
		expect(formatRate(Number.NaN)).toBe("0")
	})

	it("labels a rate with its unit", () => {
		expect(formatRateLabel(2_800)).toBe("2.8k req/s")
		expect(formatRateLabel(12, "calls")).toBe("12.0 calls/s")
	})
})

const candidate = (over: Partial<InsightCandidate> & { label: string }): InsightCandidate => ({
	kind: "service",
	p95Ms: 100,
	previousP95Ms: 100,
	spanCount: 1_000,
	...over,
})

describe("selectInsight", () => {
	it("picks the service whose p95 moved furthest", () => {
		const insight = selectInsight([
			candidate({ label: "cart-svc", p95Ms: 110, previousP95Ms: 100 }),
			candidate({ label: "pricing-svc", p95Ms: 118, previousP95Ms: 100 }),
		])
		expect(insight).toEqual({ label: "pricing-svc", deltaRatio: expect.closeTo(0.18, 5) })
	})

	it("picks a regression by its size, not its sign", () => {
		const insight = selectInsight([
			candidate({ label: "cart-svc", p95Ms: 120, previousP95Ms: 100 }),
			candidate({ label: "auth-svc", p95Ms: 50, previousP95Ms: 100 }),
		])
		expect(insight?.label).toBe("auth-svc")
		expect(insight?.deltaRatio).toBeCloseTo(-0.5, 5)
	})

	it("says nothing when nothing moved much", () => {
		expect(selectInsight([candidate({ label: "cart-svc", p95Ms: 101, previousP95Ms: 100 })])).toBeNull()
	})

	it("ignores a service with no previous window to compare against", () => {
		expect(selectInsight([candidate({ label: "new-svc", p95Ms: 400, previousP95Ms: null })])).toBeNull()
		expect(selectInsight([candidate({ label: "new-svc", p95Ms: 400, previousP95Ms: 0 })])).toBeNull()
	})

	// A database node's p95 falls back to the window's slowest call, and a max
	// against a max swings on one outlier.
	it("ignores database nodes", () => {
		expect(
			selectInsight([
				candidate({ label: "postgres", kind: "database", p95Ms: 300, previousP95Ms: 100 }),
			]),
		).toBeNull()
	})

	it("ignores a service too quiet for its p95 to mean anything", () => {
		expect(
			selectInsight([candidate({ label: "cron", p95Ms: 400, previousP95Ms: 100, spanCount: 3 })]),
		).toBeNull()
	})

	it("breaks a tie on volume, then on name, so the footer holds still", () => {
		const tied = [
			candidate({ label: "b-svc", p95Ms: 150, previousP95Ms: 100, spanCount: 100 }),
			candidate({ label: "a-svc", p95Ms: 150, previousP95Ms: 100, spanCount: 100 }),
			candidate({ label: "c-svc", p95Ms: 150, previousP95Ms: 100, spanCount: 90 }),
		]
		expect(selectInsight(tied)?.label).toBe("a-svc")
		expect(selectInsight([...tied].reverse())?.label).toBe("a-svc")
	})

	it("has nothing to say about an empty map", () => {
		expect(selectInsight([])).toBeNull()
	})
})

describe("formatInsight", () => {
	it("reads like the hosted map's footer", () => {
		expect(formatInsight({ label: "pricing-svc", deltaRatio: 0.18 }, "1H")).toBe(
			"PRICING-SVC · P95 +18% VS 1H AGO",
		)
	})

	it("keeps the direction of an improvement", () => {
		expect(formatInsight({ label: "auth-svc", deltaRatio: -0.42 }, "60S")).toBe(
			"AUTH-SVC · P95 −42% VS 60S AGO",
		)
	})
})
