import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
	DEFAULT_EXPLORER_OPTIONS,
	compileMetricRateTimeseriesQuery,
	compileMetricValueTimeseriesQuery,
} from "./use-local-metric-detail"

const params = {
	orgId: "org_local",
	startTime: "2026-07-30 13:05:00",
	endTime: "2026-07-30 14:05:00",
	bucketSeconds: 60,
	metricName: "http.server.duration",
}

const options = { ...DEFAULT_EXPLORER_OPTIONS, seriesLimit: 5 }

describe("metric detail timeseries queries", () => {
	// The chart draws at most 60 series; without the top-N cap a
	// high-cardinality install fetches and pivots every service's series before
	// the render limit ever applies.
	it("caps the value timeseries to the selected series limit in the query", () => {
		const { sql } = Effect.runSync(
			compileMetricValueTimeseriesQuery({ metricType: "gauge", options }, params),
		)
		expect(sql).toContain("WITH __series_base AS")
		expect(sql).toContain("LIMIT 5")
	})

	it("caps the rate timeseries the same way", () => {
		const { sql } = Effect.runSync(
			compileMetricRateTimeseriesQuery(
				{ metricName: "http.server.duration", bucketSeconds: 60, options },
				params,
			),
		)
		expect(sql).toContain("WITH __series_base AS")
		expect(sql).toContain("LIMIT 5")
	})

	// A series limit above the chart's own budget would refill the tail the cap
	// exists to drop, so the query keeps the smaller of the two.
	it("never asks for more series than the chart can draw", () => {
		const { sql } = Effect.runSync(
			compileMetricValueTimeseriesQuery(
				{ metricType: "gauge", options: { ...options, seriesLimit: 1000 } },
				params,
			),
		)
		expect(sql).toContain("LIMIT 60")
	})

	it("groups by an attribute key and applies the filter row", () => {
		const { sql } = Effect.runSync(
			compileMetricValueTimeseriesQuery(
				{
					metricType: "gauge",
					options: {
						...options,
						groupBy: "http.route",
						filters: [{ key: "http.method", value: "GET" }],
					},
				},
				params,
			),
		)
		expect(sql).toContain("Attributes['http.route'] AS groupName")
		expect(sql).toContain("Attributes['http.method'] = 'GET'")
	})

	it("applies the filter row to the rate timeseries CTE", () => {
		const { sql } = Effect.runSync(
			compileMetricRateTimeseriesQuery(
				{
					metricName: "http.server.duration",
					bucketSeconds: 60,
					options: { ...options, filters: [{ key: "http.method", value: "GET" }] },
				},
				params,
			),
		)
		expect(sql).toContain("Attributes['http.method'] = 'GET'")
	})
})
