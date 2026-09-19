import { describe, expect, it } from "vitest"
import {
	buildLogHistogram,
	canonicalSeverity,
	niceCeiling,
	orderBySeverity,
	pickTickIndices,
	severityColorMap,
	severityRank,
	UNSET_SEVERITY,
} from "./log-histogram"

const MINUTE = 60 * 1000
const at = (iso: string) => Date.parse(`${iso}Z`)

describe("canonicalSeverity", () => {
	it("folds the case SDKs disagree on", () => {
		expect(canonicalSeverity("Info")).toBe("INFO")
		expect(canonicalSeverity("info")).toBe("INFO")
		expect(canonicalSeverity(" WARN ")).toBe("WARN")
	})

	it("reads the query engine's empty-severity sentinel as unset", () => {
		// `buildLogsGroupNameExpr` coalesces an empty SeverityText to 'all'.
		expect(canonicalSeverity("all")).toBe(UNSET_SEVERITY)
		expect(canonicalSeverity("")).toBe(UNSET_SEVERITY)
	})
})

describe("orderBySeverity", () => {
	it("puts the levels in reading order, not in count order", () => {
		const ordered = orderBySeverity([
			{ name: "TRACE", count: 9 },
			{ name: "ERROR", count: 3 },
			{ name: "DEBUG", count: 50 },
			{ name: "INFO", count: 1 },
			{ name: "WARN", count: 7 },
		])
		expect(ordered.map((o) => o.name)).toEqual(["INFO", "WARN", "ERROR", "DEBUG", "TRACE"])
	})

	it("ranks WARNING with WARN and sorts the pair by traffic", () => {
		const ordered = orderBySeverity([
			{ name: "WARN", count: 2 },
			{ name: "ERROR", count: 100 },
			{ name: "WARNING", count: 40 },
		])
		expect(ordered.map((o) => o.name)).toEqual(["WARNING", "WARN", "ERROR"])
	})

	it("sorts unranked levels after the named ones, by traffic", () => {
		const ordered = orderBySeverity([
			{ name: "NOTICE", count: 2 },
			{ name: "FATAL", count: 11 },
			{ name: "TRACE", count: 1 },
		])
		expect(ordered.map((o) => o.name)).toEqual(["TRACE", "FATAL", "NOTICE"])
	})

	it("orders a lowercase spelling exactly as its canonical one", () => {
		const ordered = orderBySeverity([
			{ name: "debug", count: 1 },
			{ name: "info", count: 1 },
		])
		expect(ordered.map((o) => o.name)).toEqual(["info", "debug"])
	})

	it("does not mutate its input", () => {
		const options = [
			{ name: "ERROR", count: 1 },
			{ name: "INFO", count: 1 },
		]
		orderBySeverity(options)
		expect(options.map((o) => o.name)).toEqual(["ERROR", "INFO"])
	})

	it("leaves an unknown level unranked rather than guessing", () => {
		expect(severityRank("INFO")).toBeLessThan(severityRank("FATAL"))
		expect(severityRank("Warning")).toBe(severityRank("WARN"))
	})
})

describe("severityColorMap", () => {
	it("keys the swatch by the spelling the facet row carries", () => {
		const map = severityColorMap(["Error", "INFO"])
		// `FilterSection` looks `colorMap` up by exact option name — a map keyed
		// only by the canonical spelling leaves a lowercase row with no swatch.
		expect(map.Error).toBe("var(--color-severity-error)")
		expect(map.INFO).toBe("var(--color-severity-info)")
	})

	it("gives an unknown level the neutral tone instead of no colour at all", () => {
		expect(severityColorMap([UNSET_SEVERITY])[UNSET_SEVERITY]).toBe("var(--color-muted-foreground)")
	})
})

describe("buildLogHistogram", () => {
	const window = {
		startMs: at("2026-03-04T10:32:00"),
		endMs: at("2026-03-04T11:02:00"),
		bucketSeconds: 300,
	}

	it("anchors the grid to the epoch, the way toStartOfInterval does", () => {
		const histogram = buildLogHistogram(
			[{ bucket: "2026-03-04 10:30:00", groupName: "INFO", count: 4 }],
			window,
		)
		// The window starts at 10:32; the bucket the row landed in starts at 10:30.
		expect(histogram.buckets[0].startMs).toBe(at("2026-03-04T10:30:00"))
		expect(histogram.buckets[0].counts).toEqual({ INFO: 4 })
	})

	it("fills the gaps between populated buckets", () => {
		const histogram = buildLogHistogram(
			[
				{ bucket: "2026-03-04 10:30:00", groupName: "INFO", count: 1 },
				{ bucket: "2026-03-04 10:45:00", groupName: "INFO", count: 2 },
			],
			window,
		)
		expect(histogram.buckets).toHaveLength(4)
		expect(histogram.buckets.map((b) => b.total)).toEqual([1, 0, 0, 2])
		expect(histogram.buckets[1].endMs - histogram.buckets[1].startMs).toBe(5 * MINUTE)
	})

	it("drops the empty tail boundsForRange's clock-skew padding creates", () => {
		// The window runs to 11:02 — six buckets — but nothing arrived after 10:45.
		const histogram = buildLogHistogram(
			[{ bucket: "2026-03-04 10:45:00", groupName: "INFO", count: 2 }],
			window,
		)
		expect(histogram.buckets).toHaveLength(4)
		expect(histogram.buckets[histogram.buckets.length - 1].total).toBe(2)
	})

	it("keeps a leading empty stretch, which is the window genuinely outrunning the data", () => {
		const histogram = buildLogHistogram(
			[{ bucket: "2026-03-04 10:55:00", groupName: "INFO", count: 3 }],
			window,
		)
		expect(histogram.buckets.map((b) => b.total)).toEqual([0, 0, 0, 0, 0, 3])
	})

	it("is empty when nothing landed anywhere in the window", () => {
		expect(buildLogHistogram([], window).buckets).toEqual([])
		expect(buildLogHistogram([], window).total).toBe(0)
	})

	it("merges the case variants of one severity into one band", () => {
		const histogram = buildLogHistogram(
			[
				{ bucket: "2026-03-04 10:30:00", groupName: "Info", count: 2 },
				{ bucket: "2026-03-04 10:30:00", groupName: "INFO", count: 3 },
				{ bucket: "2026-03-04 10:30:00", groupName: "info", count: 5 },
			],
			window,
		)
		expect(histogram.levels).toEqual(["INFO"])
		expect(histogram.buckets[0].counts).toEqual({ INFO: 10 })
	})

	it("reports totals and the tallest column the y axis has to reach", () => {
		const histogram = buildLogHistogram(
			[
				{ bucket: "2026-03-04 10:30:00", groupName: "INFO", count: 10 },
				{ bucket: "2026-03-04 10:30:00", groupName: "ERROR", count: 5 },
				{ bucket: "2026-03-04 10:45:00", groupName: "INFO", count: 4 },
			],
			window,
		)
		expect(histogram.total).toBe(19)
		expect(histogram.maxTotal).toBe(15)
		expect(histogram.levels).toEqual(["INFO", "ERROR"])
	})

	it("stacks its levels in the sidebar's order, not in arrival order", () => {
		const histogram = buildLogHistogram(
			[
				{ bucket: "2026-03-04 10:30:00", groupName: "TRACE", count: 1 },
				{ bucket: "2026-03-04 10:30:00", groupName: "ERROR", count: 1 },
				{ bucket: "2026-03-04 10:30:00", groupName: "INFO", count: 1 },
			],
			window,
		)
		expect(histogram.levels).toEqual(["INFO", "ERROR", "TRACE"])
	})

	it("ignores a bucket outside the window it was asked for", () => {
		// A refetch that raced a range change: counting it would add traffic the
		// chart has no column to draw.
		const histogram = buildLogHistogram(
			[
				{ bucket: "2026-03-04 09:00:00", groupName: "INFO", count: 99 },
				{ bucket: "2026-03-04 10:30:00", groupName: "INFO", count: 1 },
			],
			window,
		)
		expect(histogram.total).toBe(1)
	})

	it("ignores rows the warehouse could not date", () => {
		const histogram = buildLogHistogram(
			[
				{ bucket: "0000-00-00 00:00:00", groupName: "INFO", count: 7 },
				{ bucket: "2026-03-04 10:30:00", groupName: "INFO", count: 1 },
			],
			window,
		)
		expect(histogram.total).toBe(1)
	})

	it("refuses a bucket width that would ask for thousands of columns", () => {
		expect(
			buildLogHistogram([{ bucket: "2026-03-04 10:30:00", groupName: "INFO", count: 1 }], {
				startMs: at("2026-01-01T00:00:00"),
				endMs: at("2026-03-04T00:00:00"),
				bucketSeconds: 60,
			}).buckets,
		).toEqual([])
	})

	it("refuses a nonsensical window instead of looping on it", () => {
		expect(buildLogHistogram([], { ...window, bucketSeconds: 0 }).buckets).toEqual([])
		expect(buildLogHistogram([], { ...window, endMs: window.startMs - 1 }).buckets).toEqual([])
	})
})

describe("niceCeiling", () => {
	it("climbs the 1/2/5 ladder rather than to the next power of ten", () => {
		expect(niceCeiling(110)).toBe(200)
		expect(niceCeiling(7)).toBe(10)
		expect(niceCeiling(3)).toBe(5)
		expect(niceCeiling(1)).toBe(1)
		expect(niceCeiling(4200)).toBe(5000)
	})

	it("never hands the axis a zero to divide by", () => {
		expect(niceCeiling(0)).toBe(1)
		expect(niceCeiling(Number.NaN)).toBe(1)
	})
})

describe("pickTickIndices", () => {
	it("always labels the first and last column", () => {
		const ticks = pickTickIndices(100, 6)
		expect(ticks[0]).toBe(0)
		expect(ticks[ticks.length - 1]).toBe(99)
	})

	it("labels every column when there are fewer than the target", () => {
		expect(pickTickIndices(3, 6)).toEqual([0, 1, 2])
	})

	it("spaces the rest evenly, on whole columns", () => {
		expect(pickTickIndices(11, 6)).toEqual([0, 2, 4, 6, 8, 10])
	})

	it("never repeats a column when the target crowds the axis", () => {
		const ticks = pickTickIndices(4, 6)
		expect(new Set(ticks).size).toBe(ticks.length)
	})

	it("has nothing to label on an empty axis", () => {
		expect(pickTickIndices(0, 6)).toEqual([])
		expect(pickTickIndices(10, 0)).toEqual([])
	})
})
