import { describe, expect, it } from "vitest"
import { toSpanLogMarkers } from "./log-markers"

const row = (spanId: string, logCount: unknown, errorLogCount: unknown) =>
	({ spanId, logCount, errorLogCount }) as never

describe("toSpanLogMarkers", () => {
	it("indexes each span's counts by span id", () => {
		const markers = toSpanLogMarkers([row("aaa", 3, 0), row("bbb", 7, 2)])
		expect(markers.get("aaa")).toEqual({ count: 3, errorCount: 0 })
		expect(markers.get("bbb")).toEqual({ count: 7, errorCount: 2 })
		expect(markers.size).toBe(2)
	})

	it("leaves a span with no row out of the map", () => {
		expect(toSpanLogMarkers([row("aaa", 1, 0)]).has("bbb")).toBe(false)
	})

	// A backend that quotes 64-bit integers hands back `"0"`, which is truthy —
	// the whole point of coercing rather than trusting the wire shape.
	it("coerces quoted counts, so an error count of zero stays falsy", () => {
		const markers = toSpanLogMarkers([row("aaa", "4", "0")])
		expect(markers.get("aaa")).toEqual({ count: 4, errorCount: 0 })
	})

	it("drops a row that counts nothing, and survives a count that is not a number", () => {
		const markers = toSpanLogMarkers([row("aaa", 0, 0), row("bbb", "x", 1), row("ccc", 2, "x")])
		expect(markers.has("aaa")).toBe(false)
		expect(markers.has("bbb")).toBe(false)
		expect(markers.get("ccc")).toEqual({ count: 2, errorCount: 0 })
	})
})
