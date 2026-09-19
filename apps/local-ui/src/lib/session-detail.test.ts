import { describe, expect, it } from "vitest"
import type { SessionTranscriptOutput } from "@maple/query-engine/ch"
import {
	computeActivity,
	currentIndexAt,
	customProperties,
	eventsForTab,
	IDLE_GAP_MS,
	isErrorEvent,
	offsetLabel,
	parseChTime,
	tabCounts,
	urlAt,
} from "./session-detail"

const event = (overrides: Partial<SessionTranscriptOutput> = {}): SessionTranscriptOutput => ({
	timestamp: "2026-01-01 00:00:00",
	seq: 1,
	type: "click",
	url: "",
	traceId: "",
	level: "",
	message: "",
	targetSelector: "",
	targetText: "",
	netMethod: "",
	netUrl: "",
	netStatus: 0,
	netDurationMs: 0,
	errorStack: "",
	attributes: "",
	...overrides,
})

/** `mm:ss` into the session, as a chDB datetime string. */
const at = (seconds: number): string => {
	const base = Date.parse("2026-01-01T00:00:00Z")
	return new Date(base + seconds * 1000).toISOString().slice(0, 19).replace("T", " ")
}

describe("computeActivity", () => {
	it("reports nothing derivable from fewer than two timestamped events", () => {
		expect(computeActivity([])).toEqual({ activeMs: null, idleMs: null })
		expect(computeActivity([event({ timestamp: at(0) })])).toEqual({ activeMs: null, idleMs: null })
	})

	// A session with one event has a span of nothing, which is not the same
	// claim as "engaged for 0 s" — so the strip renders "—", not a number.
	it("does not mistake an unmeasurable session for an idle one", () => {
		expect(computeActivity([event({ timestamp: "" }), event({ timestamp: at(30) })])).toEqual({
			activeMs: null,
			idleMs: null,
		})
	})

	it("counts the whole span as active when no gap exceeds the threshold", () => {
		const events = [at(0), at(10), at(40), at(90)].map((timestamp) => event({ timestamp }))
		expect(computeActivity(events)).toEqual({ activeMs: 90_000, idleMs: 0 })
	})

	it("subtracts gaps longer than the threshold from the span", () => {
		// 0s → 5s of clicking, five minutes of nothing, then 5s more.
		const events = [at(0), at(5), at(305), at(310)].map((timestamp) => event({ timestamp }))
		expect(computeActivity(events)).toEqual({ activeMs: 10_000, idleMs: 300_000 })
	})

	it("treats a gap of exactly the threshold as active", () => {
		const events = [at(0), at(60)].map((timestamp) => event({ timestamp }))
		expect(computeActivity(events)).toEqual({ activeMs: IDLE_GAP_MS, idleMs: 0 })
	})

	it("is order-independent — a transcript sorted by Seq need not be sorted by time", () => {
		const forwards = [at(0), at(5), at(305)].map((timestamp) => event({ timestamp }))
		const backwards = [...forwards].reverse()
		expect(computeActivity(backwards)).toEqual(computeActivity(forwards))
	})

	it("honours a custom threshold", () => {
		const events = [at(0), at(30), at(60)].map((timestamp) => event({ timestamp }))
		expect(computeActivity(events, 10_000)).toEqual({ activeMs: 0, idleMs: 60_000 })
	})
})

describe("currentIndexAt", () => {
	it("is -1 before the first row", () => {
		expect(currentIndexAt([1000, 2000], 500)).toBe(-1)
	})

	it("selects the last row at or before the playhead", () => {
		expect(currentIndexAt([0, 1000, 2000], 1000)).toBe(1)
		expect(currentIndexAt([0, 1000, 2000], 1999)).toBe(1)
		expect(currentIndexAt([0, 1000, 2000], 2000)).toBe(2)
		expect(currentIndexAt([0, 1000, 2000], 10_000)).toBe(2)
	})

	it("prefers the later of two rows sharing a millisecond", () => {
		expect(currentIndexAt([0, 1000, 1000], 1500)).toBe(2)
	})

	it("skips rows whose offset is unknown", () => {
		expect(currentIndexAt([Number.NaN, 1000, Number.NaN], 5000)).toBe(1)
		expect(currentIndexAt([Number.NaN, Number.NaN], 5000)).toBe(-1)
	})

	it("is -1 for an empty list", () => {
		expect(currentIndexAt([], 0)).toBe(-1)
	})
})

describe("tab counts and filtering", () => {
	const events = [
		event({ seq: 1, type: "navigation", url: "https://app.test/" }),
		event({ seq: 2, type: "click" }),
		event({ seq: 3, type: "console", level: "log", message: "hello" }),
		event({ seq: 4, type: "console", level: "error", message: "boom" }),
		event({ seq: 5, type: "network", netMethod: "GET", netUrl: "/a", netStatus: 200 }),
		event({ seq: 6, type: "network", netMethod: "GET", netUrl: "/b", netStatus: 500 }),
		event({ seq: 7, type: "error", message: "TypeError" }),
		event({ seq: 8, type: "custom", message: "plan_started" }),
	]

	it("counts every tab in one pass", () => {
		expect(tabCounts(events)).toEqual({ all: 8, console: 2, network: 2, errors: 3, events: 1 })
	})

	// Deliberate double-counting: a console row at `error` level really does
	// appear on both lists, and a badge that disagreed with the list under it
	// would be the worse bug.
	it("counts a console error on both Console and Errors", () => {
		const counts = tabCounts([event({ type: "console", level: "error" })])
		expect(counts.console).toBe(1)
		expect(counts.errors).toBe(1)
	})

	it("counts nothing for an empty transcript", () => {
		expect(tabCounts([])).toEqual({ all: 0, console: 0, network: 0, errors: 0, events: 0 })
	})

	it("filters each tab to exactly the rows its count promised", () => {
		const counts = tabCounts(events)
		for (const tab of ["all", "console", "network", "errors", "events"] as const) {
			expect(eventsForTab(events, tab)).toHaveLength(counts[tab])
		}
	})

	it("returns the transcript itself for the All tab", () => {
		expect(eventsForTab(events, "all")).toBe(events)
	})
})

describe("isErrorEvent", () => {
	it("covers all three shapes an error arrives in", () => {
		expect(isErrorEvent(event({ type: "error" }))).toBe(true)
		expect(isErrorEvent(event({ type: "console", level: "error" }))).toBe(true)
		expect(isErrorEvent(event({ type: "network", netStatus: 404 }))).toBe(true)
	})

	it("leaves warnings, successes and ordinary rows alone", () => {
		expect(isErrorEvent(event({ type: "console", level: "warn" }))).toBe(false)
		expect(isErrorEvent(event({ type: "network", netStatus: 204 }))).toBe(false)
		expect(isErrorEvent(event({ type: "click" }))).toBe(false)
	})
})

describe("urlAt", () => {
	const navigations = [
		{ offsetMs: 0, url: "https://app.test/" },
		{ offsetMs: 5000, url: "https://app.test/pricing" },
		{ offsetMs: 9000, url: "https://app.test/checkout" },
	]

	it("falls back to the entry URL before the first navigation", () => {
		expect(urlAt(navigations.slice(1), 100, "https://app.test/entry")).toBe("https://app.test/entry")
		expect(urlAt([], 100, "https://app.test/entry")).toBe("https://app.test/entry")
	})

	it("holds the latest navigation at or before the playhead", () => {
		expect(urlAt(navigations, 0, "fallback")).toBe("https://app.test/")
		expect(urlAt(navigations, 4999, "fallback")).toBe("https://app.test/")
		expect(urlAt(navigations, 5000, "fallback")).toBe("https://app.test/pricing")
		expect(urlAt(navigations, 60_000, "fallback")).toBe("https://app.test/checkout")
	})

	it("ignores a navigation that carried no URL rather than blanking the bar", () => {
		expect(urlAt([...navigations, { offsetMs: 9500, url: "" }], 10_000, "fallback")).toBe(
			"https://app.test/checkout",
		)
	})
})

describe("customProperties", () => {
	it("decodes the serialized Attributes map", () => {
		expect(customProperties(event({ type: "custom", attributes: '{"plan":"pro","seats":"3"}' }))).toEqual(
			[
				["plan", "pro"],
				["seats", "3"],
			],
		)
	})

	it("survives an absent or unparseable map", () => {
		expect(customProperties(event({ attributes: "" }))).toEqual([])
		expect(customProperties(event({ attributes: "not json" }))).toEqual([])
		expect(customProperties(event({ attributes: "[1,2]" }))).toEqual([])
	})
})

describe("parseChTime / offsetLabel", () => {
	it("reads a chDB datetime as UTC", () => {
		expect(parseChTime("2026-01-01 00:00:00")).toBe(Date.parse("2026-01-01T00:00:00Z"))
		expect(parseChTime("")).toBeNaN()
		expect(parseChTime(null)).toBeNaN()
	})

	it("labels sub-second offsets in ms and longer ones in seconds", () => {
		expect(offsetLabel(at(0), at(0))).toBe("+0ms")
		expect(offsetLabel(at(0), at(3))).toBe("+3.0s")
		expect(offsetLabel(at(0), "")).toBe("")
	})
})
