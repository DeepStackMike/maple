import { describe, expect, it } from "vitest"
// `?raw` rather than a JSON import: the card loads this file over the network
// (`?url`), the test wants its text, and neither spelling needs
// `resolveJsonModule` turned on for one file.
import atlasSource from "../assets/countries-110m.json?raw"
import { NUMERIC_TO_ALPHA2 } from "./country-numeric-codes"
import {
	ANTARCTICA_ID,
	MAP_EMPTY_FILL_CLASS,
	MAP_FILL_CLASSES,
	MAP_STEP_COUNT,
	alpha2ForOutline,
	fillClassForStep,
	mapScale,
	regionsIn,
	shadeWorld,
	stepForCount,
	stepLabel,
	unmappedCountries,
} from "./world-map"

interface Atlas {
	objects: { countries: { geometries: Array<{ id?: string; properties: { name: string } }> } }
}

// SAFETY: the file is the vendored atlas, and the two fields read below are the
// two this suite exists to check — a shape change fails the assertions rather
// than the cast.
const outlines = (JSON.parse(atlasSource) as Atlas).objects.countries.geometries

/**
 * The join the whole map rests on. The atlas identifies a country by ISO
 * numeric and every code Maple stores is alpha-2, so an outline the table has
 * no row for is a country that silently never shades — which looks exactly
 * like a country nobody visited.
 */
describe("atlas coverage", () => {
	it("resolves every numbered outline", () => {
		const unresolved = outlines
			.filter((outline) => outline.id !== undefined)
			.filter((outline) => alpha2ForOutline(outline.id, outline.properties.name) === null)
			.map((outline) => `${outline.id} ${outline.properties.name}`)
		expect(unresolved).toEqual([])
	})

	it("names the outlines ISO has not numbered", () => {
		const unnumbered = outlines
			.filter((outline) => outline.id === undefined)
			.map((outline) => outline.properties.name)
		expect(unnumbered).toEqual(["N. Cyprus", "Somaliland", "Kosovo"])
	})

	// The one of the three the geo databases still emit a code for.
	it("shades Kosovo as XK", () => {
		expect(alpha2ForOutline(undefined, "Kosovo")).toBe("XK")
		expect(alpha2ForOutline(undefined, "Somaliland")).toBeNull()
	})

	it("carries no row the atlas has no outline for", () => {
		const ids = new Set(outlines.map((outline) => outline.id))
		expect(Object.keys(NUMERIC_TO_ALPHA2).filter((id) => !ids.has(id))).toEqual([])
	})

	it("takes the id exactly as the file writes it, zero padding and all", () => {
		expect(alpha2ForOutline("004", "Afghanistan")).toBe("AF")
		expect(alpha2ForOutline("4", "Afghanistan")).toBeNull()
		expect(alpha2ForOutline(ANTARCTICA_ID, "Antarctica")).toBe("AQ")
	})
})

describe("mapScale", () => {
	it("is empty when nothing reported", () => {
		expect(mapScale([])).toEqual([])
		expect(mapScale([0, 0])).toEqual([])
	})

	it("gives one step per value while there are fewer values than shades", () => {
		expect(mapScale([9, 4, 1])).toEqual([
			{ min: 1, max: 1 },
			{ min: 2, max: 4 },
			{ min: 5, max: 9 },
		])
	})

	it("never repeats a break", () => {
		expect(mapScale([3, 3, 3, 3, 3, 3])).toEqual([{ min: 3, max: 3 }])
	})

	it("cuts on quantiles, so one huge country does not flatten the rest", () => {
		const counts = [400, 9, 8, 7, 6, 5, 4, 3, 2, 1]
		const scale = mapScale(counts)
		expect(scale).toHaveLength(MAP_STEP_COUNT)
		// Equal intervals over 1–400 would put all nine of the small countries in
		// the palest step; quantiles spread them across four.
		expect(scale.filter((step) => step.max < 400)).toHaveLength(MAP_STEP_COUNT - 1)
		expect(scale.at(-1)).toEqual({ min: 9, max: 400 })
	})

	it("is gapless and ascending", () => {
		const scale = mapScale([1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144])
		expect(scale[0].min).toBe(1)
		for (const [index, step] of scale.entries()) {
			expect(step.min).toBeLessThanOrEqual(step.max)
			if (index > 0) expect(step.min).toBe(scale[index - 1].max + 1)
		}
	})

	it("has a shade for every step it can produce", () => {
		expect(MAP_FILL_CLASSES).toHaveLength(MAP_STEP_COUNT)
	})

	// A range with three countries in it still has a darkest country, and it
	// should read as one — so a short scale gives up its palest shades, not its
	// darkest.
	it("anchors the darkest shade to the top step, however short the scale", () => {
		const short = mapScale([40, 30, 10])
		expect(short.map((_, index) => fillClassForStep(short, index))).toEqual(MAP_FILL_CLASSES.slice(-3))

		const full = mapScale([1, 2, 3, 4, 5])
		expect(full.map((_, index) => fillClassForStep(full, index))).toEqual([...MAP_FILL_CLASSES])
		expect(fillClassForStep(full, -1)).toBe(MAP_EMPTY_FILL_CLASS)
	})

	it("labels a step by its range, and a single count by itself", () => {
		expect(mapScale([9, 4, 1]).map(stepLabel)).toEqual(["1", "2–4", "5–9"])
		expect(stepLabel({ min: 1000, max: 2000 })).toBe("1,000–2,000")
	})
})

describe("stepForCount", () => {
	const scale = mapScale([400, 9, 8, 7, 6, 5, 4, 3, 2, 1])

	it("puts a count in the step whose range contains it", () => {
		for (const [index, step] of scale.entries()) {
			expect(stepForCount(scale, step.min)).toBe(index)
			expect(stepForCount(scale, step.max)).toBe(index)
		}
	})

	it("keeps no data off the scale", () => {
		expect(stepForCount(scale, 0)).toBe(-1)
		expect(stepForCount([], 5)).toBe(-1)
	})

	// A count above the top break can only come from a scale built elsewhere,
	// and darkest is the honest answer either way.
	it("clamps a count above the last break to the darkest step", () => {
		expect(stepForCount(scale, 10_000)).toBe(scale.length - 1)
	})
})

describe("shadeWorld", () => {
	const rows = [
		{ name: "us", count: 40, share: 0.5 },
		{ name: "DE", count: 30, share: 0.375 },
		{ name: "XX", count: 10, share: 0.125 },
	]

	it("keys countries by upper-case alpha-2 and keeps the card's share", () => {
		const { byCode, totalSessions } = shadeWorld(rows)
		expect(totalSessions).toBe(80)
		expect(byCode.get("US")).toEqual({ name: "us", count: 40, share: 0.5, step: 2 })
		expect(byCode.has("us")).toBe(false)
	})

	it("reports the codes no outline can show", () => {
		// `XX` is Cloudflare's "could not place this address"; `SG` has no polygon
		// at 110m.
		expect(unmappedCountries(rows).map((row) => row.name)).toEqual(["XX"])
		expect(unmappedCountries([{ name: "SG", count: 1, share: 1 }])).toHaveLength(1)
		expect(unmappedCountries([{ name: "XK", count: 1, share: 1 }])).toEqual([])
	})
})

describe("regionsIn", () => {
	const rows = [
		{ name: "US-CA", count: 12, share: 0.5 },
		{ name: "DE-NRW", count: 7, share: 0.29 },
		{ name: "US-TX", count: 5, share: 0.21 },
	]

	it("takes a country's subdivisions in order and drops the qualifier", () => {
		expect(regionsIn(rows, "US", 3)).toEqual([
			{ name: "CA", count: 12, share: 0.5 },
			{ name: "TX", count: 5, share: 0.21 },
		])
	})

	it("honours the limit and matches nothing on a prefix that is not one", () => {
		expect(regionsIn(rows, "us", 1).map((row) => row.name)).toEqual(["CA"])
		expect(regionsIn(rows, "U", 3)).toEqual([])
	})
})
