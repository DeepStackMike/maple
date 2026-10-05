import { describe, expect, it } from "vitest"
import type { CH } from "@maple/query-engine"
import { foldCatalogRows, previewValues, summarizeCatalogRows } from "./use-local-metrics"

const row = (overrides: Partial<CH.ListMetricsOutput>): CH.ListMetricsOutput => ({
	metricName: "http.server.requests",
	metricType: "sum",
	serviceName: "api",
	metricDescription: "",
	metricUnit: "{request}",
	dataPointCount: 10,
	firstSeen: "2026-07-30 13:00:00",
	lastSeen: "2026-07-30 14:00:00",
	isMonotonic: 1,
	...overrides,
})

describe("foldCatalogRows", () => {
	it("folds per-service rows into one entry spanning the earliest first-seen", () => {
		const { entries, serviceFacets } = foldCatalogRows([
			row({}),
			row({ serviceName: "worker", firstSeen: "2026-07-30 12:00:00", dataPointCount: 5 }),
		])
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({
			serviceNames: ["api", "worker"],
			dataPointCount: 15,
			firstSeen: "2026-07-30 12:00:00",
			isMonotonic: true,
		})
		expect(serviceFacets).toEqual([
			{ name: "api", count: 1 },
			{ name: "worker", count: 1 },
		])
	})
})

describe("previewValues", () => {
	const points = [
		{ bucket: "b1", avgValue: 100, sumValue: 0, dataPointCount: 1 },
		{ bucket: "b2", avgValue: 130, sumValue: 0, dataPointCount: 1 },
		{ bucket: "b3", avgValue: 10, sumValue: 0, dataPointCount: 1 },
	]

	it("previews a counter's rise per bucket, not its running total", () => {
		expect(previewValues({ metricType: "sum", isMonotonic: true }, points)).toEqual([
			{ bucket: "b2", v: 30 },
			// A reset (the process restarted) is not a negative rate.
			{ bucket: "b3", v: 0 },
		])
	})

	it("previews everything else as the average value", () => {
		expect(previewValues({ metricType: "gauge", isMonotonic: false }, points).map((p) => p.v)).toEqual([
			100, 130, 10,
		])
	})
})

describe("summarizeCatalogRows", () => {
	it("counts distinct metrics and sums datapoints per type, across services", () => {
		const summary = summarizeCatalogRows([
			row({ serviceName: "api", dataPointCount: 10 }),
			row({ serviceName: "web", dataPointCount: 5 }),
			row({ metricName: "process.memory", metricType: "gauge", dataPointCount: 7 }),
		])
		expect(summary).toEqual([
			{ metricType: "sum", metricCount: 1, dataPointCount: 15 },
			{ metricType: "gauge", metricCount: 1, dataPointCount: 7 },
		])
	})
})
