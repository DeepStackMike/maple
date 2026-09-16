import { describe, expect, it } from "vitest"
import {
	OVERVIEW_SERIES,
	lastSeenByService,
	overviewSeries,
	summarizeServices,
	type OverviewPoint,
	type ServiceVolume,
} from "./home-overview"

const service = (
	serviceName: string,
	spanCount: number,
	errorCount: number,
	p95LatencyMs: number,
): ServiceVolume => ({ serviceName, spanCount, errorCount, p95LatencyMs })

describe("summarizeServices", () => {
	it("sums the catalog into the KPI strip", () => {
		const totals = summarizeServices([service("api", 800, 40, 120), service("worker", 200, 0, 20)])
		expect(totals.serviceCount).toBe(2)
		expect(totals.spanCount).toBe(1000)
		expect(totals.errorCount).toBe(40)
		expect(totals.errorRate).toBeCloseTo(0.04)
	})

	// The whole point of weighting: a quiet, slow service must not drag the
	// headline latency to the midpoint between it and the traffic that matters.
	it("weights the merged p95 by spans, not by service", () => {
		const totals = summarizeServices([service("api", 900, 0, 100), service("cron", 100, 0, 1000)])
		expect(totals.p95LatencyMs).toBeCloseTo(190)
	})

	it("reports zeros rather than NaN for an empty window", () => {
		const totals = summarizeServices([])
		expect(totals).toEqual({
			serviceCount: 0,
			spanCount: 0,
			errorCount: 0,
			errorRate: 0,
			p95LatencyMs: 0,
		})
	})

	// A service can be listed with no spans at all in the window (the catalog's
	// estimate can round a sampled slice to nothing); dividing by that total is
	// the obvious way to get NaN onto a tile.
	it("survives a service row with no spans", () => {
		const totals = summarizeServices([service("ghost", 0, 0, 0)])
		expect(totals.serviceCount).toBe(1)
		expect(totals.errorRate).toBe(0)
		expect(totals.p95LatencyMs).toBe(0)
	})
})

describe("overviewSeries", () => {
	const points: OverviewPoint[] = [
		{ bucket: "2026-09-16 10:00:00", serviceName: "api", count: 100, errorRate: 0.1 },
		{ bucket: "2026-09-16 10:00:00", serviceName: "worker", count: 300, errorRate: 0 },
		{ bucket: "2026-09-16 11:00:00", serviceName: "api", count: 50, errorRate: 0.02 },
	]

	it("folds the per-service cells into one row per bucket", () => {
		expect(overviewSeries(points)).toEqual([
			{ bucket: "2026-09-16 10:00:00", [OVERVIEW_SERIES.spans]: 400, [OVERVIEW_SERIES.errors]: 10 },
			{ bucket: "2026-09-16 11:00:00", [OVERVIEW_SERIES.spans]: 50, [OVERVIEW_SERIES.errors]: 1 },
		])
	})

	// Rates are per-cell fractions. Adding them would score the 300-span service
	// that never failed and the 100-span one that failed 10% as the same bucket.
	it("recovers error counts from the rate before summing", () => {
		const skewed: OverviewPoint[] = [
			{ bucket: "b", serviceName: "busy", count: 1000, errorRate: 0.01 },
			{ bucket: "b", serviceName: "quiet", count: 2, errorRate: 0.5 },
		]
		expect(overviewSeries(skewed)[0][OVERVIEW_SERIES.errors]).toBe(11)
	})

	it("sorts buckets even when the rows arrive out of order", () => {
		const shuffled = [points[2], points[0], points[1]]
		expect(overviewSeries(shuffled).map((row) => row.bucket)).toEqual([
			"2026-09-16 10:00:00",
			"2026-09-16 11:00:00",
		])
	})

	it("returns no rows for an empty range", () => {
		expect(overviewSeries([])).toEqual([])
	})
})

describe("lastSeenByService", () => {
	it("takes each service's latest bucket carrying spans", () => {
		const lastSeen = lastSeenByService([
			{ bucket: "2026-09-16 09:00:00", serviceName: "api", count: 10, errorRate: 0 },
			{ bucket: "2026-09-16 11:00:00", serviceName: "api", count: 4, errorRate: 0 },
			{ bucket: "2026-09-16 10:00:00", serviceName: "worker", count: 1, errorRate: 0 },
		])
		expect(lastSeen.get("api")).toBe("2026-09-16 11:00:00")
		expect(lastSeen.get("worker")).toBe("2026-09-16 10:00:00")
	})

	// An empty trailing bucket is the in-flight one; reporting it as "last seen"
	// would make every idle service look live.
	it("ignores buckets with no spans", () => {
		const lastSeen = lastSeenByService([
			{ bucket: "2026-09-16 09:00:00", serviceName: "api", count: 10, errorRate: 0 },
			{ bucket: "2026-09-16 12:00:00", serviceName: "api", count: 0, errorRate: 0 },
		])
		expect(lastSeen.get("api")).toBe("2026-09-16 09:00:00")
	})

	it("omits a service that never carried spans", () => {
		const lastSeen = lastSeenByService([
			{ bucket: "2026-09-16 09:00:00", serviceName: "silent", count: 0, errorRate: 0 },
		])
		expect(lastSeen.has("silent")).toBe(false)
	})
})
