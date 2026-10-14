import { describe, expect, it } from "vitest"
import {
	canLiveTail,
	formatRefreshInterval,
	liveTailState,
	nextTickMs,
	NOT_INSPECTING,
	parseRefreshSeconds,
	refreshParam,
} from "./log-live-tail"
import { customRangeKey } from "./time"

const custom = customRangeKey({ fromMs: Date.UTC(2026, 9, 14, 11), toMs: Date.UTC(2026, 9, 14, 12) })

describe("refresh param", () => {
	it("reads a cadence from the closed set and treats anything else as off", () => {
		expect(parseRefreshSeconds("10")).toBe(10)
		expect(parseRefreshSeconds("7")).toBe(0)
		expect(parseRefreshSeconds("")).toBe(0)
		expect(parseRefreshSeconds(null)).toBe(0)
	})

	it("drops the param when off and round-trips a cadence", () => {
		expect(refreshParam(0)).toBeNull()
		expect(parseRefreshSeconds(refreshParam(30))).toBe(30)
	})

	it("labels seconds and minutes", () => {
		expect([0, 5, 60, 300].map((s) => formatRefreshInterval(s as 0 | 5 | 60 | 300))).toEqual([
			"Off",
			"5s",
			"1m",
			"5m",
		])
	})
})

describe("liveTailState", () => {
	it("ticks at the cadence while nobody is inspecting", () => {
		const state = liveTailState(5, "1h", NOT_INSPECTING)
		expect(state.held).toBe(false)
		expect(nextTickMs(state)).toBe(5000)
	})

	it("holds while the pointer is over the stream or the drawer is open", () => {
		for (const inputs of [
			{ ...NOT_INSPECTING, hovering: true },
			{ ...NOT_INSPECTING, detailOpen: true },
		]) {
			const state = liveTailState(5, "1h", inputs)
			expect(state.held).toBe(true)
			expect(state.canJumpToLatest).toBe(false)
			expect(nextTickMs(state)).toBeNull()
		}
	})

	it("offers Jump to latest only when scroll is holding it", () => {
		const state = liveTailState(10, "1h", { ...NOT_INSPECTING, scrolledAway: true })
		expect(state.held).toBe(true)
		expect(state.canJumpToLatest).toBe(true)
	})

	it("never runs or holds over a custom range, which has nothing new to tail", () => {
		expect(canLiveTail(custom)).toBe(false)
		const state = liveTailState(5, custom, { ...NOT_INSPECTING, hovering: true })
		expect(state).toEqual({ intervalSeconds: 0, held: false, canJumpToLatest: false })
		expect(nextTickMs(state)).toBeNull()
	})

	it("does not report a hold when the tail is off", () => {
		expect(liveTailState(0, "1h", { ...NOT_INSPECTING, scrolledAway: true }).held).toBe(false)
	})
})
