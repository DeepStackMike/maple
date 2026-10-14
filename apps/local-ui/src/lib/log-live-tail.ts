// Live tail for the Logs page: a shareable refresh cadence, and when it holds.
//
// Pure. Ported from the hosted `/logs` live tail (`?refresh=`, the same closed
// set as dashboards): the page reloads every N seconds, but never while the
// reader is inspecting — pointer over the stream, the drawer open, or the
// stream scrolled away from the newest rows — because a reload under the
// cursor moves the row being read.

import { parseCustomRange } from "./time"

/** The query param carrying the cadence, in seconds. Absent is off. */
export const REFRESH_PARAM = "refresh"

/** The closed set of cadences, `0` being off. */
export const REFRESH_INTERVAL_OPTIONS = [0, 5, 10, 30, 60, 300] as const
export type RefreshIntervalSeconds = (typeof REFRESH_INTERVAL_OPTIONS)[number]

const OPTION_SET: ReadonlySet<number> = new Set(REFRESH_INTERVAL_OPTIONS)

function isRefreshInterval(value: number): value is RefreshIntervalSeconds {
	return OPTION_SET.has(value)
}

/** The cadence a `refresh` param names; anything outside the set (or absent) is off. */
export function parseRefreshSeconds(value: string | null | undefined): RefreshIntervalSeconds {
	if (!value) return 0
	const seconds = Number(value)
	return isRefreshInterval(seconds) ? seconds : 0
}

/** The param value for a cadence: `null` (drop it) for off. */
export function refreshParam(seconds: RefreshIntervalSeconds): string | null {
	return seconds === 0 ? null : String(seconds)
}

export function formatRefreshInterval(seconds: RefreshIntervalSeconds): string {
	if (seconds === 0) return "Off"
	return seconds < 60 ? `${seconds}s` : `${seconds / 60}m`
}

/**
 * A custom range is a fixed window, so there is nothing new to tail: the
 * control is hidden and the URL keeps the cadence for when a preset returns.
 */
export function canLiveTail(range: string): boolean {
	return parseCustomRange(range) === null
}

/** What the stream reports up so the page can hold its tail while someone reads. */
export interface InspectInputs {
	readonly hovering: boolean
	readonly scrolledAway: boolean
	readonly detailOpen: boolean
}

export const NOT_INSPECTING: InspectInputs = { hovering: false, scrolledAway: false, detailOpen: false }

export function isInspecting(inputs: InspectInputs): boolean {
	return inputs.hovering || inputs.scrolledAway || inputs.detailOpen
}

export interface LiveTailState {
	/** Seconds between reloads while running; `0` when the tail is off or cannot run. */
	readonly intervalSeconds: RefreshIntervalSeconds
	/** On, but holding still while the reader inspects. */
	readonly held: boolean
	/** Held, with scroll among the reasons: the one cause "Jump to latest" undoes by itself. */
	readonly canJumpToLatest: boolean
}

export function liveTailState(
	refresh: RefreshIntervalSeconds,
	range: string,
	inputs: InspectInputs,
): LiveTailState {
	const intervalSeconds = canLiveTail(range) ? refresh : 0
	const held = intervalSeconds > 0 && isInspecting(inputs)
	return { intervalSeconds, held, canJumpToLatest: held && inputs.scrolledAway }
}

/** The delay to the next reload, or `null` when nothing should be scheduled. */
export function nextTickMs(state: LiveTailState): number | null {
	return state.intervalSeconds > 0 && !state.held ? state.intervalSeconds * 1000 : null
}
