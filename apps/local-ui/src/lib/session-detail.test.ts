import { describe, expect, it } from "vitest"
import type { SessionSpanOutput, SessionTranscriptOutput } from "@maple/query-engine/ch"
import {
	computeActivity,
	currentIndexAt,
	customProperties,
	eventsForTab,
	IDLE_GAP_MS,
	isErrorEvent,
	offsetLabel,
	parseChTime,
	matchErrorSpan,
	matchNetworkSpan,
	recoverTraceLinks,
	sessionSpanWindow,
	spanStartMs,
	SPAN_WINDOW_PAD_MS,
	tabCounts,
	traceLinkFor,
	transcriptRowId,
	unionTraceIds,
	urlAt,
	urlPath,
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

// Recovering the row → trace link
//
// With the browser SDK's own fetch tracing on, the distilled `network` rows
// arrive with an empty TraceId: the replay capture's fetch wrapper sits OUTSIDE
// the OTel one, so it reads the active trace id before the fetch span exists.
// The spans still carry `session.id`, so the link is recoverable from session +
// method + URL + time — which is what these functions do.

/** A span of the session, as `sessionSpansQuery` returns it. */
const span = (overrides: Partial<SessionSpanOutput> = {}): SessionSpanOutput => ({
	traceId: "trace-a",
	spanId: "span-a",
	name: "GET /api/orders",
	kind: "SPAN_KIND_CLIENT",
	serviceName: "web",
	startTime: "2026-01-01 00:00:00.000000000",
	// `at(0)` in nanoseconds — the string form the query returns.
	startTimeNs: String(Date.parse("2026-01-01T00:00:00Z")) + "000000",
	durationMs: 12,
	statusCode: "Ok",
	httpMethod: "GET",
	httpUrl: "https://shop.example/api/orders",
	httpRoute: "/api/orders",
	serverAddress: "shop.example",
	...overrides,
})

/** A span starting `seconds` into the session. */
const spanAt = (seconds: number, overrides: Partial<SessionSpanOutput> = {}): SessionSpanOutput =>
	span({
		startTime: at(seconds),
		startTimeNs: String(Date.parse("2026-01-01T00:00:00Z") + seconds * 1000) + "000000",
		...overrides,
	})

const request = (seconds: number, overrides: Partial<SessionTranscriptOutput> = {}) =>
	event({
		type: "network",
		timestamp: at(seconds),
		netMethod: "GET",
		netUrl: "/api/orders",
		netStatus: 200,
		...overrides,
	})

describe("spanStartMs", () => {
	// 1.7e18 is far above 2^53 — `Number(ns) / 1e6` rounds before it divides.
	it("takes milliseconds off the leading digits of the nanosecond string", () => {
		expect(spanStartMs(span({ startTimeNs: "1767225600123456789" }))).toBe(1767225600123)
	})

	it("falls back to the rendered datetime when the nanosecond field is unusable", () => {
		expect(spanStartMs(span({ startTimeNs: "", startTime: "2026-01-01 00:00:05" }))).toBe(
			Date.parse("2026-01-01T00:00:05Z"),
		)
	})
})

describe("urlPath", () => {
	it("reduces an absolute and a relative URL for the same endpoint to one key", () => {
		expect(urlPath("https://shop.example/api/orders?page=2")).toBe("/api/orders")
		expect(urlPath("/api/orders?page=3")).toBe("/api/orders")
	})

	it("treats a trailing slash as the same endpoint", () => {
		expect(urlPath("/api/orders/")).toBe("/api/orders")
		expect(urlPath("https://shop.example/")).toBe("/")
	})

	it("returns nothing for an empty URL rather than a bare slash", () => {
		expect(urlPath("")).toBe("")
	})
})

describe("matchNetworkSpan", () => {
	it("matches a row to the span with the same absolute URL", () => {
		const exact = spanAt(0, { spanId: "exact", httpUrl: "https://shop.example/api/orders?page=2" })
		const other = spanAt(0, { spanId: "other", httpUrl: "https://shop.example/api/users" })
		const row = request(0, { netUrl: "https://shop.example/api/orders?page=2" })
		expect(matchNetworkSpan(row, [other, exact])?.spanId).toBe("exact")
	})

	// The common case: the page called `fetch("/api/orders")` and the span
	// recorded the resolved absolute URL, so only the path can ever agree.
	it("matches a relative row URL to an absolute span URL on the path alone", () => {
		expect(matchNetworkSpan(request(0), [spanAt(0)])?.spanId).toBe("span-a")
	})

	it("prefers the exact URL over a path-only match", () => {
		const pathOnly = spanAt(0, { spanId: "path", httpUrl: "https://cdn.example/api/orders" })
		const exact = spanAt(1, { spanId: "exact", httpUrl: "https://shop.example/api/orders" })
		const row = request(0, { netUrl: "https://shop.example/api/orders" })
		expect(matchNetworkSpan(row, [pathOnly, exact])?.spanId).toBe("exact")
	})

	// The browser's own span is the top of the trace and the one the request
	// *is*; the server span is what is left when fetch instrumentation is off.
	it("prefers the browser CLIENT span over the SERVER span of the same request", () => {
		const server = spanAt(0, { spanId: "server", kind: "SPAN_KIND_SERVER" })
		const client = spanAt(1, { spanId: "client", kind: "Client" })
		expect(matchNetworkSpan(request(0), [server, client])?.spanId).toBe("client")
	})

	it("falls back to the SERVER span when no client span was exported", () => {
		const server = spanAt(0, { spanId: "server", kind: "SPAN_KIND_SERVER" })
		expect(matchNetworkSpan(request(0), [server])?.spanId).toBe("server")
	})

	// A poll against one endpoint produces several identical candidates; the
	// answer has to be the same one on every render.
	it("breaks a tie by taking the closest start, then the earliest", () => {
		const early = spanAt(8, { spanId: "early" })
		const near = spanAt(10, { spanId: "near" })
		const late = spanAt(11, { spanId: "late" })
		expect(matchNetworkSpan(request(10), [early, late, near])?.spanId).toBe("near")
		// Equidistant either side: the earlier one wins, deterministically.
		expect(matchNetworkSpan(request(10), [spanAt(9, { spanId: "before" }), late])?.spanId).toBe("before")
	})

	it("returns nothing when the method disagrees", () => {
		expect(matchNetworkSpan(request(0, { netMethod: "POST" }), [spanAt(0)])).toBeUndefined()
	})

	it("returns nothing when the path disagrees", () => {
		expect(matchNetworkSpan(request(0, { netUrl: "/api/users" }), [spanAt(0)])).toBeUndefined()
	})

	it("returns nothing when the nearest candidate is outside the window", () => {
		expect(matchNetworkSpan(request(0), [spanAt(3)])).toBeUndefined()
		expect(matchNetworkSpan(request(0), [spanAt(3)], 4000)?.spanId).toBe("span-a")
	})

	// An INTERNAL span named after the same route is not the request.
	it("ignores spans that are neither client nor server", () => {
		expect(matchNetworkSpan(request(0), [spanAt(0, { kind: "SPAN_KIND_INTERNAL" })])).toBeUndefined()
	})

	it("ignores a span carrying no http method, which it cannot be checked against", () => {
		expect(matchNetworkSpan(request(0), [spanAt(0, { httpMethod: "" })])).toBeUndefined()
	})
})

describe("matchErrorSpan", () => {
	const thrown = (seconds: number) =>
		event({ type: "error", timestamp: at(seconds), message: "Cannot read properties of undefined" })

	// The nearest *successful* span to an exception is usually an unrelated
	// request that happened to be in flight — offering it would be a confident
	// wrong answer, so a failing span is required rather than preferred.
	it("takes the nearest failing span and ignores successful ones", () => {
		const ok = spanAt(10, { spanId: "ok" })
		const failed = spanAt(11, { spanId: "failed", statusCode: "Error" })
		expect(matchErrorSpan(thrown(10), [ok, failed])?.spanId).toBe("failed")
	})

	it("returns nothing when every failing span is outside the window", () => {
		expect(matchErrorSpan(thrown(0), [spanAt(5, { statusCode: "Error" })])).toBeUndefined()
	})

	it("returns nothing when nothing failed", () => {
		expect(matchErrorSpan(thrown(0), [spanAt(0)])).toBeUndefined()
	})
})

describe("recoverTraceLinks / traceLinkFor", () => {
	// The id the SDK recorded is the truth; a heuristic that disagreed with it
	// would be strictly worse than no heuristic.
	it("never overrides a row that already carries a trace id", () => {
		const row = request(0, { traceId: "recorded" })
		const links = recoverTraceLinks([row], [spanAt(0, { traceId: "guessed" })])
		expect(links.size).toBe(0)
		expect(traceLinkFor(row, links)).toEqual({ traceId: "recorded", matched: false })
	})

	it("marks a recovered link as matched", () => {
		const row = request(0)
		const links = recoverTraceLinks([row], [spanAt(0, { traceId: "trace-z" })])
		expect(links.get(transcriptRowId(row))?.traceId).toBe("trace-z")
		expect(traceLinkFor(row, links)).toEqual({ traceId: "trace-z", matched: true })
	})

	it("leaves rows with no match, and kinds that are not requests, unlinked", () => {
		const click = event({ type: "click", timestamp: at(0) })
		const unmatched = request(30)
		const links = recoverTraceLinks([click, unmatched], [spanAt(0)])
		expect(links.size).toBe(0)
		expect(traceLinkFor(unmatched, links)).toBeUndefined()
	})
})

describe("unionTraceIds", () => {
	// An active session's metadata row has no TraceIds at all — the unload
	// beacon that writes them has not fired — so the spans are the only source.
	it("adds the traces only the spans know about, keeping the recorded ones first", () => {
		expect(unionTraceIds(["a"], [spanAt(0, { traceId: "b" }), spanAt(1, { traceId: "c" })])).toEqual([
			"a",
			"b",
			"c",
		])
		expect(unionTraceIds([], [spanAt(0, { traceId: "b" })])).toEqual(["b"])
	})

	it("de-duplicates across both sources and drops empty ids", () => {
		const spans = [spanAt(0, { traceId: "a" }), spanAt(1, { traceId: "" }), spanAt(2, { traceId: "b" })]
		expect(unionTraceIds(["a", "a", ""], spans)).toEqual(["a", "b"])
	})
})

describe("sessionSpanWindow", () => {
	const session = (overrides: Partial<Parameters<typeof sessionSpanWindow>[0]> = {}) => ({
		startTime: "2026-01-01 00:00:30",
		endTime: "2026-01-01 00:02:30" as string | null,
		durationMs: 120_000 as number | null,
		...overrides,
	})

	it("pads and rounds the session's own bounds to whole minutes", () => {
		const window = sessionSpanWindow(session())!
		expect(new Date(window.startMs).toISOString()).toBe("2025-12-31T23:59:00.000Z")
		expect(new Date(window.endMs).toISOString()).toBe("2026-01-01T00:04:00.000Z")
	})

	// An active session has no end time — the unload beacon that writes one has
	// not fired — and is exactly the case where the recovered link matters most,
	// because nothing has written `TraceIds` either.
	it("runs an unended session to now", () => {
		const now = Date.parse("2026-01-01T00:10:20Z")
		const window = sessionSpanWindow(session({ endTime: null, durationMs: null }), now)!
		expect(new Date(window.endMs).toISOString()).toBe("2026-01-01T00:11:00.000Z")
	})

	// Rounding is not cosmetic: an unrounded `Date.now()` end would change the
	// query key on every render, and every render would be a cache miss.
	it("returns the same window for two instants in the same minute", () => {
		const a = sessionSpanWindow(
			session({ endTime: null, durationMs: null }),
			Date.parse("2026-01-01T00:10:00Z"),
		)
		const b = sessionSpanWindow(
			session({ endTime: null, durationMs: null }),
			Date.parse("2026-01-01T00:10:59Z"),
		)
		expect(a).toEqual(b)
	})

	it("falls back to the duration when only the end time is missing", () => {
		const window = sessionSpanWindow(session({ endTime: null }), Date.parse("2026-06-01T00:00:00Z"))!
		expect(window.endMs).toBe(
			Math.ceil((Date.parse("2026-01-01T00:02:30Z") + SPAN_WINDOW_PAD_MS) / 60_000) * 60_000,
		)
	})

	it("derives nothing from an unparseable start", () => {
		expect(sessionSpanWindow(session({ startTime: "" }))).toBeUndefined()
	})
})
