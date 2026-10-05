import { describe, expect, it } from "vitest"
import { isPlainClick, openTraceQuery, resolvePeek, stepFor, stepTarget, withoutPeek } from "./trace-peek"

const rows = [{ traceId: "a" }, { traceId: "b" }, { traceId: "c" }]

describe("resolvePeek", () => {
	it("is closed without a peek param", () => {
		expect(resolvePeek(rows, null)).toBeNull()
		expect(resolvePeek(rows, "")).toBeNull()
	})

	it("finds the row and its position", () => {
		expect(resolvePeek(rows, "b")).toEqual({ traceId: "b", position: { index: 1, count: 3 } })
	})

	it("still opens a trace whose row is not loaded, without a position", () => {
		expect(resolvePeek(rows, "zzz")).toEqual({ traceId: "zzz", position: null })
	})
})

describe("stepTarget", () => {
	it("walks the list and stops at either end", () => {
		expect(stepTarget(rows, resolvePeek(rows, "b"), 1)?.traceId).toBe("c")
		expect(stepTarget(rows, resolvePeek(rows, "b"), -1)?.traceId).toBe("a")
		expect(stepTarget(rows, resolvePeek(rows, "c"), 1)).toBeUndefined()
		expect(stepTarget(rows, resolvePeek(rows, "a"), -1)).toBeUndefined()
	})

	it("has nowhere to go from an unloaded peek", () => {
		expect(stepTarget(rows, resolvePeek(rows, "zzz"), 1)).toBeUndefined()
	})
})

describe("stepFor", () => {
	it("maps arrows and j/k", () => {
		expect(stepFor("ArrowDown")).toBe(1)
		expect(stepFor("j")).toBe(1)
		expect(stepFor("ArrowUp")).toBe(-1)
		expect(stepFor("K")).toBe(-1)
		expect(stepFor("Enter")).toBeUndefined()
	})
})

describe("isPlainClick", () => {
	const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }
	it("takes only an unmodified primary click", () => {
		expect(isPlainClick(click)).toBe(true)
		expect(isPlainClick({ ...click, metaKey: true })).toBe(false)
		expect(isPlainClick({ ...click, ctrlKey: true })).toBe(false)
		expect(isPlainClick({ ...click, shiftKey: true })).toBe(false)
		expect(isPlainClick({ ...click, button: 1 })).toBe(false)
	})
})

describe("peek queries", () => {
	const query = new URLSearchParams("service=api&peek=b&peekSpan=s1&range=1h")

	it("closing keeps the list's filters", () => {
		expect(withoutPeek(query).toString()).toBe("service=api&range=1h")
	})

	it("opening the page carries the selected span as spanId", () => {
		expect(openTraceQuery(query, "s1").toString()).toBe("service=api&range=1h&spanId=s1")
		expect(openTraceQuery(query, undefined).get("spanId")).toBeNull()
	})
})
