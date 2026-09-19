// The choropleth's arithmetic: which outline is which country, and how dark it
// gets.
//
// Two things are separated here that look like one thing on the map. The atlas
// decides which countries *exist* — 177 outlines, identified by ISO 3166-1
// numeric — and the Countries breakdown decides which of them are *shaded*,
// keyed by alpha-2. Neither list contains the other: the breakdown reports
// codes the atlas has no polygon for at this resolution, and the atlas draws
// countries nobody visited. Everything below is one side of that join.
//
// Pure, and separate from the card, for the usual reason: the bucket a session
// count lands in is the whole claim the map makes, and it is worth a test
// rather than a squint at a shade of blue.

import type { BreakdownRow } from "./web-analytics"
import { NUMERIC_TO_ALPHA2 } from "./country-numeric-codes"

/**
 * The outlines the atlas draws but ISO has not numbered, by the name the file
 * gives them.
 *
 * Only Kosovo is here. `XK` is not an ISO code — it is the user-assigned code
 * the geolocation databases settled on, and it is what Cloudflare's
 * `CF-IPCountry` returns for a Kosovar visitor, so the row exists in our data
 * and there is a polygon to put it on.
 *
 * The other two unnumbered outlines, N. Cyprus and Somaliland, are left
 * unshaded on purpose: no geo database resolves an address to either, it
 * resolves them to `CY` and `SO` — which are separate polygons that get the
 * sessions. Shading the disputed outline as well would double-count it.
 */
const UNNUMBERED_OUTLINES: ReadonlyMap<string, string> = new Map([["Kosovo", "XK"]])

/** The vendored table as a lookup: the atlas hands out ids one at a time. */
const ALPHA2_BY_NUMERIC: ReadonlyMap<string, string> = new Map(Object.entries(NUMERIC_TO_ALPHA2))

/** Antarctica: 8% of the frame, and no sessions. Dropped before the map is projected. */
export const ANTARCTICA_ID = "010"

/**
 * The alpha-2 code of one atlas outline, or `null` when it has none.
 *
 * `id` is the numeric code as the file writes it — zero-padded, a string
 * (`"840"`) — and is absent on the three outlines ISO has not numbered.
 */
export function alpha2ForOutline(id: string | number | undefined, name: string): string | null {
	if (id !== undefined) return ALPHA2_BY_NUMERIC.get(String(id)) ?? null
	return UNNUMBERED_OUTLINES.get(name) ?? null
}

/** Every country the atlas can shade. */
const ATLAS_CODES: ReadonlySet<string> = new Set([
	...ALPHA2_BY_NUMERIC.values(),
	...UNNUMBERED_OUTLINES.values(),
])

/**
 * Codes in the data that the map cannot draw, largest first.
 *
 * Two kinds end up here and both are worth admitting under the map rather than
 * silently dropping: countries too small for a 110m outline (`SG`, `MT`, the
 * island states), and the non-countries an edge lookup can return — `XX` when
 * Cloudflare cannot place the address, `T1` for a Tor exit. A map whose shades
 * add up to less than the Countries card beside it should say why.
 */
export function unmappedCountries(rows: ReadonlyArray<BreakdownRow>): ReadonlyArray<BreakdownRow> {
	return rows.filter((row) => !ATLAS_CODES.has(row.name.toUpperCase()))
}

// Shading

/** How many shades the scale has, and therefore how many rows the legend has. */
export const MAP_STEP_COUNT = 5

/**
 * The fill of each step, palest first.
 *
 * Opacity steps of `--primary` rather than five separate colours: the scale is
 * one ordered quantity, a hue ramp would read as five categories, and the
 * theme's own primary is the only colour on the page that already works in
 * both light and dark. The last step is the full colour.
 */
export const MAP_FILL_CLASSES: ReadonlyArray<string> = [
	"fill-primary/20",
	"fill-primary/40",
	"fill-primary/60",
	"fill-primary/80",
	"fill-primary",
]

/** The fill of a country the data says nothing about — land, not zero traffic. */
export const MAP_EMPTY_FILL_CLASS = "fill-muted"

/** One shade of the scale, as an inclusive range of session counts. */
export interface MapStep {
	readonly min: number
	readonly max: number
}

/**
 * The scale the map and its legend share, palest step first.
 *
 * **Quantiles, not equal intervals.** Web traffic is a power law — one country
 * with 400 sessions and nine with 3 is the normal shape of this data, and
 * cutting 0–400 into five equal bands puts every country but one in the palest
 * step and makes the map a picture of a single country. Quantile breaks give
 * each shade roughly a fifth of the *countries*, which is what a reader is
 * actually scanning for: who is in the top fifth.
 *
 * Breaks land on values that occur, so the legend can print them as counts
 * ("3–11 sessions") instead of as fractions of a maximum. Distinct values are
 * what get divided: with four countries reporting, four steps are drawn rather
 * than five, one of them empty.
 *
 * Counts are session counts — non-negative integers — so a step begins one
 * above the step below it, and the ranges are gapless and closed on both ends.
 */
export function mapScale(counts: ReadonlyArray<number>): ReadonlyArray<MapStep> {
	const distinct = [...new Set(counts.filter((count) => count > 0))].sort((a, b) => a - b)
	if (distinct.length === 0) return []

	const stepCount = Math.min(MAP_STEP_COUNT, distinct.length)
	const maxima: number[] = []
	for (let step = 1; step <= stepCount; step++) {
		const max = distinct[Math.ceil((step * distinct.length) / stepCount) - 1]
		if (maxima[maxima.length - 1] !== max) maxima.push(max)
	}

	return maxima.map((max, index) => ({ min: index === 0 ? distinct[0] : maxima[index - 1] + 1, max }))
}

/**
 * Which shade a count takes, or `-1` for a country with no sessions.
 *
 * `-1` rather than 0 because "no data" is not the bottom of the scale: it is
 * the neutral fill, off the legend entirely. A country the breakdown never
 * mentioned and a country with one session are different claims.
 */
export function stepForCount(scale: ReadonlyArray<MapStep>, count: number): number {
	if (count <= 0) return -1
	const index = scale.findIndex((step) => count <= step.max)
	return index === -1 ? scale.length - 1 : index
}

/**
 * The fill of one step of a scale, and of everything off it.
 *
 * The darkest shade is anchored to the **top** step rather than to the fifth
 * one, so "darkest is the most" holds on a range with three countries as well
 * as on one with fifty. A short scale therefore drops shades off the pale end,
 * where 20% and 40% of the primary are hardest to tell apart.
 */
export function fillClassForStep(scale: ReadonlyArray<MapStep>, step: number): string {
	if (step < 0) return MAP_EMPTY_FILL_CLASS
	return MAP_FILL_CLASSES[MAP_FILL_CLASSES.length - scale.length + step]
}

/** One legend row: `"1"` for a step of a single count, `"3–11"` for a range. */
export function stepLabel(step: MapStep): string {
	const min = step.min.toLocaleString()
	return step.min === step.max ? min : `${min}–${step.max.toLocaleString()}`
}

/** A country as the map draws it: its row from the breakdown, plus its shade. */
export interface ShadedCountry extends BreakdownRow {
	readonly step: number
}

/** Everything the map and its legend read, built once per breakdown response. */
export interface WorldShading {
	readonly scale: ReadonlyArray<MapStep>
	/** By upper-case alpha-2 — the atlas is keyed that way and `Country` is not guaranteed to be. */
	readonly byCode: ReadonlyMap<string, ShadedCountry>
	readonly totalSessions: number
}

/**
 * Fold the Countries breakdown into the map's lookup.
 *
 * Shares are the rows' own — `withShares` computed them over every country the
 * breakdown returned, including the ones this map cannot draw — so a tooltip
 * here and the Countries card beside it never disagree about what "12% of
 * traffic" means.
 */
export function shadeWorld(rows: ReadonlyArray<BreakdownRow>): WorldShading {
	const scale = mapScale(rows.map((row) => row.count))
	const byCode = new Map<string, ShadedCountry>()
	let totalSessions = 0
	for (const row of rows) {
		totalSessions += row.count
		byCode.set(row.name.toUpperCase(), { ...row, step: stepForCount(scale, row.count) })
	}
	return { scale, byCode, totalSessions }
}

/**
 * The regions of one country, largest first — the tooltip's second half.
 *
 * Free: the Regions card already ran this query, and its rows are qualified
 * (`US-TX`), which is exactly the prefix needed to pick a country's
 * subdivisions out of them. Cities are deliberately not here — that card's
 * query carries no country qualifier, so `Springfield` cannot be attributed to
 * a country without a second query and a guess.
 */
export function regionsIn(
	rows: ReadonlyArray<BreakdownRow>,
	code: string,
	limit: number,
): ReadonlyArray<BreakdownRow> {
	const prefix = `${code.toUpperCase()}-`
	return rows
		.filter((row) => row.name.toUpperCase().startsWith(prefix))
		.slice(0, limit)
		.map((row) => ({ ...row, name: row.name.slice(prefix.length) }))
}
