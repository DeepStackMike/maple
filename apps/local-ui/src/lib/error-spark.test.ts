import { describe, expect, it } from "vitest"
import { denseCounts, groupSparkPoints, sparkWindow } from "./error-spark"

// 2026-01-02 12:00:00 UTC
const ANCHOR = Date.UTC(2026, 0, 2, 12, 0, 0)

describe("sparkWindow", () => {
	it("cuts every preset into a legible number of ladder-sized buckets", () => {
		const cases: Array<[string, number]> = [
			["1h", 120],
			["6h", 600],
			["24h", 3600],
			["7d", 21600],
			["30d", 86400],
		]
		for (const [range, bucketSeconds] of cases) {
			const window = sparkWindow(range, ANCHOR)
			expect(window.bucketSeconds).toBe(bucketSeconds)
			const buckets = (window.endMs - window.startMs) / 1000 / window.bucketSeconds
			expect(buckets).toBeGreaterThanOrEqual(20)
			expect(buckets).toBeLessThanOrEqual(60)
		}
	})

	it("falls back to the widest preset for an unknown range key", () => {
		expect(sparkWindow("nonsense", ANCHOR)).toEqual(sparkWindow("30d", ANCHOR))
	})

	it("ends at now, not at the query's skew-padded upper bound", () => {
		// `boundsForRange` pads an hour into the future so a skewed exporter's rows
		// are not filtered out. Drawing that hour would trail every error off into
		// zeroes it has no data for.
		expect(sparkWindow("1h", ANCHOR).endMs).toBe(ANCHOR)
		expect(sparkWindow("1h", ANCHOR).startMs).toBe(ANCHOR - 3_600_000)
	})
})

describe("groupSparkPoints", () => {
	it("keys series by fingerprint and keeps the query's bucket order", () => {
		const grouped = groupSparkPoints([
			{ fingerprintHash: "1", bucket: "2026-01-02 11:00:00", count: 2 },
			{ fingerprintHash: "2", bucket: "2026-01-02 11:00:00", count: 5 },
			{ fingerprintHash: "1", bucket: "2026-01-02 11:30:00", count: 3 },
		])
		expect(grouped.get("1")?.map((p) => p.count)).toEqual([2, 3])
		expect(grouped.get("2")?.map((p) => p.count)).toEqual([5])
		expect(grouped.get("3")).toBeUndefined()
	})
})

describe("denseCounts", () => {
	const window = { startMs: Date.UTC(2026, 0, 2, 11, 0, 0), endMs: ANCHOR, bucketSeconds: 900 }

	it("fills the empty buckets the query never returns", () => {
		// Two occurrences an hour apart and nothing between them. Without the
		// zeroes this is a flat line, indistinguishable from steady traffic.
		const counts = denseCounts(
			[
				{ bucket: "2026-01-02 11:00:00", count: 4 },
				{ bucket: "2026-01-02 12:00:00", count: 1 },
			],
			window,
		)
		expect(counts).toEqual([4, 0, 0, 0, 1])
	})

	it("lands a bucket on the slot ClickHouse's epoch-aligned interval produced", () => {
		const counts = denseCounts([{ bucket: "2026-01-02 11:30:00", count: 7 }], window)
		expect(counts).toEqual([0, 0, 7, 0, 0])
	})

	it("sums two rows that fall in one slot", () => {
		const counts = denseCounts(
			[
				{ bucket: "2026-01-02 11:15:00", count: 2 },
				{ bucket: "2026-01-02 11:15:00", count: 3 },
			],
			window,
		)
		expect(counts[1]).toBe(5)
	})

	it("drops occurrences outside the drawn window instead of clamping them to its edge", () => {
		// The query's upper bound is padded an hour for clock skew; a skewed
		// exporter's row piled onto the last slot would read as a spike.
		const counts = denseCounts(
			[
				{ bucket: "2026-01-02 10:00:00", count: 99 },
				{ bucket: "2026-01-02 13:00:00", count: 99 },
			],
			window,
		)
		expect(counts).toEqual([0, 0, 0, 0, 0])
	})

	it("ignores an unparseable or zero bucket rather than throwing", () => {
		expect(denseCounts([{ bucket: "", count: 5 }], window)).toEqual([0, 0, 0, 0, 0])
		expect(denseCounts([{ bucket: "0000-00-00 00:00:00", count: 5 }], window)).toEqual([0, 0, 0, 0, 0])
	})

	it("returns a full row of zeroes for no points at all", () => {
		expect(denseCounts([], window)).toEqual([0, 0, 0, 0, 0])
	})
})
