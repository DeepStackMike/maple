import { describe, expect, it } from "vitest"
import {
	CONVERSION_WINDOWS,
	DEFAULT_CONVERSION_WINDOW,
	FUNNEL_MAX_STEPS,
	decodeFunnelSteps,
	encodeFunnelSteps,
	formatPercent,
	funnelStepSlots,
	isRunnableFunnel,
	parseConversionWindow,
	toFunnelStages,
} from "./product-analytics"

describe("funnel step encoding", () => {
	it("round-trips step names through the `steps` param", () => {
		const steps = ["page_viewed", "signup_completed", "plan_started"]
		expect(encodeFunnelSteps(steps)).toBe("page_viewed,signup_completed,plan_started")
		expect(decodeFunnelSteps(encodeFunnelSteps(steps))).toEqual(steps)
	})

	// `track()` takes a caller-supplied name with no character restrictions, so
	// the separator is exactly what a real name can contain.
	it("round-trips names containing the separator", () => {
		const steps = ["checkout,step 1", "checkout%step 2"]
		expect(decodeFunnelSteps(encodeFunnelSteps(steps))).toEqual(steps)
	})

	// The picker's shape is URL state: a slot the user just added has to survive
	// the round trip, or "Add step" appears to do nothing.
	it("keeps unset steps, including a trailing one", () => {
		expect(decodeFunnelSteps(encodeFunnelSteps(["a", "b", ""]))).toEqual(["a", "b", ""])
		expect(encodeFunnelSteps(["a", "", "c"])).toBe("a,,c")
		expect(decodeFunnelSteps("a,,c")).toEqual(["a", "", "c"])
	})

	it("encodes a funnel with nothing picked as an empty param", () => {
		expect(encodeFunnelSteps([])).toBe("")
		expect(encodeFunnelSteps(["", "", ""])).toBe("")
		expect(decodeFunnelSteps("")).toEqual([])
		expect(decodeFunnelSteps(null)).toEqual([])
	})

	it("cuts a hand-edited URL to the step ceiling", () => {
		const raw = ["a", "b", "c", "d", "e", "f", "g"].join(",")
		expect(decodeFunnelSteps(raw)).toHaveLength(FUNNEL_MAX_STEPS)
	})

	it("turns an undecodable escape into an unset step instead of throwing", () => {
		expect(decodeFunnelSteps("a,%E0%A4%A,c")).toEqual(["a", "", "c"])
	})

	it("keeps a repeated event, whose identity is its position", () => {
		expect(decodeFunnelSteps("a,b,a")).toEqual(["a", "b", "a"])
	})
})

describe("funnel step validation", () => {
	it("needs at least two set steps and at most the ceiling", () => {
		expect(isRunnableFunnel([])).toBe(false)
		expect(isRunnableFunnel(["a"])).toBe(false)
		expect(isRunnableFunnel(["a", "b"])).toBe(true)
		expect(isRunnableFunnel(["a", "b", "c", "d", "e"])).toBe(true)
		expect(isRunnableFunnel(["a", "b", "c", "d", "e", "f"])).toBe(false)
	})

	it("refuses a funnel with a gap", () => {
		expect(isRunnableFunnel(["a", "", "c"])).toBe(false)
		expect(isRunnableFunnel(["a", ""])).toBe(false)
	})

	it("pads the picker to the minimum and trims it to the ceiling", () => {
		expect(funnelStepSlots([])).toEqual(["", ""])
		expect(funnelStepSlots(["a"])).toEqual(["a", ""])
		expect(funnelStepSlots(["a", "b", "c"])).toEqual(["a", "b", "c"])
		expect(funnelStepSlots(["a", "b", "c", "d", "e", "f"])).toHaveLength(FUNNEL_MAX_STEPS)
	})
})

describe("conversion window", () => {
	it("clamps a URL-supplied window to a preset", () => {
		expect(parseConversionWindow("1h").seconds).toBe(3_600)
		expect(parseConversionWindow("7d").seconds).toBe(604_800)
		expect(parseConversionWindow("3y").key).toBe(DEFAULT_CONVERSION_WINDOW)
		expect(parseConversionWindow(null).key).toBe(DEFAULT_CONVERSION_WINDOW)
	})

	it("offers a default that is one of the presets", () => {
		expect(CONVERSION_WINDOWS.some((w) => w.key === DEFAULT_CONVERSION_WINDOW)).toBe(true)
	})
})

describe("toFunnelStages", () => {
	const names = ["viewed", "signed_up", "paid"]

	it("derives conversion, step conversion and drop-off from the step counts", () => {
		const stages = toFunnelStages(names, [
			{ step: 1, count: 200 },
			{ step: 2, count: 50 },
			{ step: 3, count: 10 },
		])
		expect(stages.map((s) => s.count)).toEqual([200, 50, 10])
		expect(stages.map((s) => s.conversion)).toEqual([1, 0.25, 0.05])
		expect(stages.map((s) => s.stepConversion)).toEqual([null, 0.25, 0.2])
		expect(stages.map((s) => s.dropOff)).toEqual([null, 150, 40])
	})

	it("reads an empty range as a stage nobody reached, not as a shorter funnel", () => {
		const stages = toFunnelStages(names, [])
		expect(stages).toHaveLength(3)
		expect(stages.every((s) => s.count === 0 && s.conversion === 0)).toBe(true)
		expect(stages[2].stepConversion).toBe(0)
		expect(stages[2].dropOff).toBe(0)
	})

	it("matches rows by step number rather than by arrival order", () => {
		const stages = toFunnelStages(names, [
			{ step: 3, count: 1 },
			{ step: 1, count: 4 },
			{ step: 2, count: 2 },
		])
		expect(stages.map((s) => s.count)).toEqual([4, 2, 1])
	})
})

describe("formatPercent", () => {
	it("keeps a decimal only where it carries information", () => {
		expect(formatPercent(1)).toBe("100%")
		expect(formatPercent(0.421)).toBe("42%")
		expect(formatPercent(0.071)).toBe("7.1%")
		expect(formatPercent(0)).toBe("0%")
	})
})
