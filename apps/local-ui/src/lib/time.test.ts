import { afterEach, describe, expect, it, vi } from "vitest"
import {
	boundsForRange,
	customRangeError,
	customRangeKey,
	formatAbsoluteRange,
	formatDurationLabel,
	fromDateTimeLocalInput,
	MAX_CUSTOM_RANGE_MS,
	parseCustomRange,
	rangeWindowSeconds,
	resolveRange,
	toDateTimeLocalInput,
} from "./time"

describe("boundsForRange", () => {
	afterEach(() => vi.useRealTimers())

	it("can advance every consumer from one explicit page anchor", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-07-30T14:05:00Z"))
		const initial = boundsForRange("1h", Date.now())

		vi.setSystemTime(new Date("2026-07-30T16:05:00Z"))
		const advanced = boundsForRange("1h", Date.now())

		expect(initial).toEqual({
			startTime: "2026-07-30 13:05:00",
			endTime: "2026-07-30 15:05:00",
		})
		expect(advanced).toEqual({
			startTime: "2026-07-30 15:05:00",
			endTime: "2026-07-30 17:05:00",
		})
	})
})

// A custom window is UTC epoch seconds on the wire, so these can be written as
// UTC instants; only the picker's inputs and labels speak the local clock.
const FROM = Date.UTC(2026, 8, 18, 9, 0, 0)
const TO = Date.UTC(2026, 8, 19, 17, 30, 0)

describe("custom range keys", () => {
	it("round-trips a window through the URL", () => {
		const key = customRangeKey({ fromMs: FROM, toMs: TO })
		expect(key).toBe(`custom_${FROM / 1000}_${TO / 1000}`)
		expect(parseCustomRange(key)).toEqual({ fromMs: FROM, toMs: TO })
	})

	it("survives URLSearchParams unescaped, so a shared hash stays readable", () => {
		const key = customRangeKey({ fromMs: FROM, toMs: TO })
		expect(new URLSearchParams({ range: key }).toString()).toBe(`range=${key}`)
	})

	it("rejects anything a hand-edited URL can carry", () => {
		expect(parseCustomRange(undefined)).toBeNull()
		expect(parseCustomRange("7d")).toBeNull()
		expect(parseCustomRange("custom_")).toBeNull()
		expect(parseCustomRange("custom_abc_123")).toBeNull()
		expect(parseCustomRange("custom_1_2_3")).toBeNull()
		// Inverted and zero-length windows.
		expect(parseCustomRange(`custom_${TO / 1000}_${FROM / 1000}`)).toBeNull()
		expect(parseCustomRange(`custom_${FROM / 1000}_${FROM / 1000}`)).toBeNull()
		// Wider than the store retains.
		const tooWide = FROM + MAX_CUSTOM_RANGE_MS + 60_000
		expect(parseCustomRange(`custom_${FROM / 1000}_${tooWide / 1000}`)).toBeNull()
	})
})

describe("resolveRange", () => {
	afterEach(() => vi.useRealTimers())

	it("resolves a preset to a look-back from the anchor", () => {
		const resolved = resolveRange("24h", FROM)
		expect(resolved).toMatchObject({
			startMs: FROM - 24 * 60 * 60 * 1000,
			endMs: FROM,
			seconds: 86_400,
			absolute: false,
			label: "24H",
			shortLabel: "24H",
		})
	})

	it("resolves a custom key to its own bounds, ignoring the anchor", () => {
		const key = customRangeKey({ fromMs: FROM, toMs: TO })
		expect(resolveRange(key, Date.now())).toMatchObject({
			startMs: FROM,
			endMs: TO,
			seconds: (TO - FROM) / 1000,
			absolute: true,
			shortLabel: "33H",
		})
	})

	it("falls back to the widest preset for a key it cannot read", () => {
		expect(resolveRange("custom_nonsense", FROM)).toEqual(resolveRange("30d", FROM))
		expect(resolveRange("nonsense", FROM)).toEqual(resolveRange("30d", FROM))
	})
})

describe("boundsForRange with a custom window", () => {
	it("uses the exact bounds, with none of a preset's skew padding", () => {
		const key = customRangeKey({ fromMs: FROM, toMs: TO })
		expect(boundsForRange(key)).toEqual({
			startTime: "2026-09-18 09:00:00",
			endTime: "2026-09-19 17:30:00",
		})
	})

	it("still pads a preset's upper bound an hour ahead", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-09-19T17:30:00Z"))
		expect(boundsForRange("1h")).toEqual({
			startTime: "2026-09-19 16:30:00",
			endTime: "2026-09-19 18:30:00",
		})
	})
})

describe("rangeWindowSeconds", () => {
	it("is the preset's length, or the custom window's own", () => {
		expect(rangeWindowSeconds("7d")).toBe(7 * 24 * 3600)
		expect(rangeWindowSeconds(customRangeKey({ fromMs: FROM, toMs: TO }))).toBe((TO - FROM) / 1000)
	})
})

describe("customRangeError", () => {
	const now = TO

	it("accepts a window the store can answer", () => {
		expect(customRangeError({ fromMs: FROM, toMs: TO }, now)).toBeNull()
	})

	it("explains every way a window can be unusable", () => {
		expect(customRangeError({ fromMs: FROM }, now)).toMatch(/both/i)
		expect(customRangeError({ fromMs: TO, toMs: FROM }, now)).toMatch(/after the start/i)
		expect(customRangeError({ fromMs: now + 3 * 3600_000, toMs: now + 4 * 3600_000 }, now)).toMatch(
			/future/i,
		)
		expect(customRangeError({ fromMs: FROM, toMs: FROM + MAX_CUSTOM_RANGE_MS + 1 }, now)).toMatch(
			/90 days/i,
		)
	})

	it("tolerates an end slightly ahead of now — exporters' clocks drift", () => {
		expect(customRangeError({ fromMs: FROM, toMs: now + 30 * 60_000 }, now)).toBeNull()
	})
})

describe("datetime-local inputs", () => {
	it("round-trips through the local clock", () => {
		const local = new Date(2026, 8, 18, 9, 5, 0).getTime()
		expect(toDateTimeLocalInput(local)).toBe("2026-09-18T09:05")
		expect(fromDateTimeLocalInput("2026-09-18T09:05")).toBe(local)
	})

	it("reads the seconds some browsers append, and rejects the rest", () => {
		expect(fromDateTimeLocalInput("2026-09-18T09:05:30")).toBe(new Date(2026, 8, 18, 9, 5, 30).getTime())
		expect(fromDateTimeLocalInput("")).toBeNull()
		expect(fromDateTimeLocalInput("18/09/2026 09:05")).toBeNull()
	})
})

describe("formatDurationLabel", () => {
	it("labels a preset-shaped span exactly as the preset key does", () => {
		expect(formatDurationLabel(3600)).toBe("1H")
		expect(formatDurationLabel(6 * 3600)).toBe("6H")
		expect(formatDurationLabel(24 * 3600)).toBe("24H")
		expect(formatDurationLabel(7 * 86_400)).toBe("7D")
		expect(formatDurationLabel(30 * 86_400)).toBe("30D")
	})

	it("keeps a ragged short span in minutes rather than rounding it into a lie", () => {
		expect(formatDurationLabel(45 * 60)).toBe("45M")
		expect(formatDurationLabel(150 * 60)).toBe("150M")
	})
})

describe("formatAbsoluteRange", () => {
	it("names a same-day window's day once", () => {
		const from = new Date(2026, 8, 18, 9, 0).getTime()
		const to = new Date(2026, 8, 18, 17, 30).getTime()
		expect(formatAbsoluteRange({ fromMs: from, toMs: to }, from)).toContain("09:00 \u2192 17:30")
		expect(formatAbsoluteRange({ fromMs: from, toMs: to }, from).match(/Sep/g)).toHaveLength(1)
	})

	it("names both days when the window crosses midnight", () => {
		const from = new Date(2026, 8, 18, 9, 0).getTime()
		const to = new Date(2026, 8, 19, 17, 30).getTime()
		const label = formatAbsoluteRange({ fromMs: from, toMs: to }, from)
		expect(label.match(/Sep/g)).toHaveLength(2)
	})
})
