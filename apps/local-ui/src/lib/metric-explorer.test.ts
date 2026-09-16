import { describe, expect, it } from "vitest"
import {
	DEFAULT_SERIES_LIMIT,
	decodeMetricFilters,
	encodeMetricFilters,
	parseSeriesLimit,
} from "./metric-explorer"

describe("metric filter encoding", () => {
	it("round-trips filters through the `where` param", () => {
		const filters = [
			{ key: "http.route", value: "/api/users" },
			{ key: "region", value: "us-east-1" },
		]
		const encoded = encodeMetricFilters(filters)
		expect(encoded).toBe("http.route:%2Fapi%2Fusers,region:us-east-1")
		expect(decodeMetricFilters(encoded)).toEqual(filters)
	})

	// The separators are exactly the characters a real attribute value carries
	// (`http.method:GET`, a comma-joined list), so they must survive the trip.
	it("round-trips values containing the separators", () => {
		const filters = [{ key: "db.statement", value: "a:b,c" }]
		expect(decodeMetricFilters(encodeMetricFilters(filters))).toEqual(filters)
	})

	it("encodes an empty filter set as an empty param", () => {
		expect(encodeMetricFilters([])).toBe("")
		expect(decodeMetricFilters("")).toEqual([])
		expect(decodeMetricFilters(null)).toEqual([])
	})

	it("keeps empty values, which match datapoints missing the key", () => {
		expect(decodeMetricFilters("region:")).toEqual([{ key: "region", value: "" }])
	})

	it("drops pairs a hand-edited URL can produce instead of throwing", () => {
		// No separator, empty key, and an undecodable escape.
		expect(decodeMetricFilters("region,:us-east-1,%E0%A4%A:x,region:us-east-1")).toEqual([
			{ key: "region", value: "us-east-1" },
		])
	})

	it("drops duplicate pairs so a repeated filter is applied once", () => {
		expect(decodeMetricFilters("region:us-east-1,region:us-east-1,region:eu-west-1")).toEqual([
			{ key: "region", value: "us-east-1" },
			{ key: "region", value: "eu-west-1" },
		])
	})

	it("clamps the series limit to a preset", () => {
		expect(parseSeriesLimit("5")).toBe(5)
		expect(parseSeriesLimit("20")).toBe(20)
		expect(parseSeriesLimit("9999")).toBe(DEFAULT_SERIES_LIMIT)
		expect(parseSeriesLimit("abc")).toBe(DEFAULT_SERIES_LIMIT)
		expect(parseSeriesLimit(null)).toBe(DEFAULT_SERIES_LIMIT)
	})
})
