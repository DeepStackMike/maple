// URL state and derived shapes for the Analytics tab.
//
// The funnel a user builds lives entirely in the hash query params (`steps`,
// `window`), so a funnel is a link the same way a metric chart is. That makes
// the wire format part of the contract: this module is the only place that
// knows it, and it is pure so the round-trip and the validation are testable
// without a browser.

/** A funnel needs a from and a to; fewer is a count, not a conversion. */
export const FUNNEL_MIN_STEPS = 2

/**
 * Local mode's ceiling, well under the engine's `FUNNEL_MAX_STEPS` of 10. The
 * picker renders one select per step in a single panel, and each extra step is
 * another `windowFunnel` condition over the same scan — five is as deep as the
 * panel reads, and past that the drop-off bars stop being legible anyway.
 */
export const FUNNEL_MAX_STEPS = 5

export interface ConversionWindow {
	readonly key: string
	readonly label: string
	readonly seconds: number
}

/**
 * How long the whole chain has to complete, measured from the step-1 event.
 * Three presets rather than a free-form duration: the number is a funnel's
 * definition, not a filter, and a typo in it silently changes the answer.
 */
export const CONVERSION_WINDOWS: ReadonlyArray<ConversionWindow> = [
	{ key: "1h", label: "within 1 hour", seconds: 60 * 60 },
	{ key: "24h", label: "within 24 hours", seconds: 24 * 60 * 60 },
	{ key: "7d", label: "within 7 days", seconds: 7 * 24 * 60 * 60 },
]

export const DEFAULT_CONVERSION_WINDOW = "24h"

/** Clamps a URL-supplied window to one of the presets. */
export function parseConversionWindow(raw: string | null | undefined): ConversionWindow {
	const match = CONVERSION_WINDOWS.find((w) => w.key === raw)
	return match ?? CONVERSION_WINDOWS.find((w) => w.key === DEFAULT_CONVERSION_WINDOW)!
}

/**
 * Event names joined by `,`, each percent-encoded so a name containing the
 * separator survives. `URLSearchParams` encodes the result a second time on the
 * way into the hash and decodes that layer on the way out, so the two encodings
 * compose rather than collide — the same scheme as the metric explorer's
 * `where` param.
 *
 * Unset steps are kept, trailing ones included: the picker's *shape* is URL
 * state too, so a slot the user just added survives the round trip instead of
 * vanishing on the next render. A funnel with nothing picked at all encodes as
 * the empty string, which drops the param and leaves a fresh picker.
 */
export function encodeFunnelSteps(steps: ReadonlyArray<string>): string {
	if (steps.every((step) => step === "")) return ""
	return steps.map((step) => encodeURIComponent(step)).join(",")
}

/**
 * Inverse of {@link encodeFunnelSteps}. A hand-edited URL is untrusted input:
 * an undecodable escape becomes an unset step rather than throwing, and
 * anything past {@link FUNNEL_MAX_STEPS} is cut — the engine would reject an
 * over-long funnel, and a URL is not the place to discover that.
 *
 * Duplicates are deliberately kept: an event can legitimately appear twice in
 * one funnel, and the step's position is its identity.
 */
export function decodeFunnelSteps(raw: string | null | undefined): string[] {
	if (!raw) return []
	return raw
		.split(",")
		.slice(0, FUNNEL_MAX_STEPS)
		.map((step) => {
			try {
				return decodeURIComponent(step)
			} catch {
				return ""
			}
		})
}

/**
 * Whether the picker's current state is a funnel the engine can run: enough
 * steps, not too many, and no gaps. The panel shows the chart only for a
 * runnable funnel, so a half-built one never fires a query.
 */
export function isRunnableFunnel(steps: ReadonlyArray<string>): boolean {
	return (
		steps.length >= FUNNEL_MIN_STEPS &&
		steps.length <= FUNNEL_MAX_STEPS &&
		steps.every((step) => step !== "")
	)
}

/**
 * Pad or trim a decoded step list to the shape the picker renders: always at
 * least {@link FUNNEL_MIN_STEPS} selects, never more than {@link FUNNEL_MAX_STEPS}.
 */
export function funnelStepSlots(steps: ReadonlyArray<string>): string[] {
	const slots = steps.slice(0, FUNNEL_MAX_STEPS)
	while (slots.length < FUNNEL_MIN_STEPS) slots.push("")
	return slots
}

export interface FunnelStage {
	/** 1-based step index, as the engine numbers them. */
	readonly step: number
	readonly name: string
	readonly count: number
	/** Share of step 1 (0–1). 0 when nobody entered. */
	readonly conversion: number
	/** Share of the previous step (0–1); `null` on step 1. */
	readonly stepConversion: number | null
	/** How many were lost since the previous step; `null` on step 1. */
	readonly dropOff: number | null
}

/**
 * Join the funnel's step names to the engine's `{ step, count }` rows.
 *
 * The builder always returns one row per step, but the join is by step number
 * with a 0 default anyway: an empty range and a dropped row then read the same
 * way — a stage nobody reached — instead of shortening the funnel on screen.
 */
export function toFunnelStages(
	names: ReadonlyArray<string>,
	rows: ReadonlyArray<{ readonly step: number; readonly count: number }>,
): FunnelStage[] {
	const counts = new Map(rows.map((row) => [row.step, row.count]))
	const entered = counts.get(1) ?? 0
	return names.map((name, index): FunnelStage => {
		const count = counts.get(index + 1) ?? 0
		const previous = index === 0 ? null : (counts.get(index) ?? 0)
		return {
			step: index + 1,
			name,
			count,
			conversion: entered > 0 ? count / entered : 0,
			stepConversion: previous === null ? null : previous > 0 ? count / previous : 0,
			dropOff: previous === null ? null : previous - count,
		}
	})
}

/** `42.1%` / `7%` — one decimal only where it carries information. */
export function formatPercent(fraction: number): string {
	const pct = fraction * 100
	return `${pct.toFixed(pct > 0 && pct < 10 ? 1 : 0)}%`
}
