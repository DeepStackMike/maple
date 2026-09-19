// The session page's arithmetic, kept out of the view.
//
// Everything here is a pure function over the distilled transcript
// (`session_events`) and the playback clock. The view renders; this file
// decides what "active", "the current row" and "the page the user was on"
// mean, so those three answers are testable without a DOM or an rrweb player.

import { parseAttributes } from "@maple/ui/lib/span-tree"
import type { SessionTranscriptOutput } from "@maple/query-engine/ch"

/** Parse a chDB UTC datetime string (`'YYYY-MM-DD HH:MM:SS'`) to epoch ms; `NaN` when unparseable. */
export function parseChTime(value: string | null | undefined): number {
	if (!value) return NaN
	return Date.parse(`${value.replace(" ", "T")}Z`)
}

// Active / idle

/**
 * A gap longer than this between two distilled events is idle time.
 *
 * The session was open across it, but nothing happened — no click, no request,
 * no navigation. One minute is the browser SDK's own engagement threshold
 * (`sessionActivityAggregateQuery` uses the same number), so the local page and
 * the cloud's ACTIVE column count the same seconds.
 */
export const IDLE_GAP_MS = 60_000

export interface SessionActivity {
	/** Engaged time (ms): the session's span minus its idle gaps. */
	readonly activeMs: number | null
	/** Idle time (ms): Σ of the gaps longer than the threshold. */
	readonly idleMs: number | null
}

const NOT_DERIVABLE: SessionActivity = { activeMs: null, idleMs: null }

/**
 * Active and idle time across a transcript.
 *
 * Both are `null` — rendered as "—", not as zero — when fewer than two events
 * carry a usable timestamp. A session with one event has a span of nothing,
 * which is not the same claim as "this user was engaged for 0 s", and the stats
 * strip should not make the second one.
 */
export function computeActivity(
	events: ReadonlyArray<SessionTranscriptOutput>,
	idleGapMs: number = IDLE_GAP_MS,
): SessionActivity {
	const times = events
		.map((event) => parseChTime(event.timestamp))
		.filter((ms) => Number.isFinite(ms))
		.sort((a, b) => a - b)
	if (times.length < 2) return NOT_DERIVABLE

	const first = times[0]!
	const last = times[times.length - 1]!
	let idleMs = 0
	for (let i = 1; i < times.length; i++) {
		const gap = times[i]! - times[i - 1]!
		if (gap > idleGapMs) idleMs += gap
	}
	return { activeMs: Math.max(0, last - first - idleMs), idleMs }
}

// Event classification

export type SessionEventTab = "all" | "console" | "network" | "errors" | "events"

export const SESSION_EVENT_TABS: ReadonlyArray<SessionEventTab> = [
	"all",
	"console",
	"network",
	"errors",
	"events",
]

export const SESSION_EVENT_TAB_LABELS = {
	all: "All",
	console: "Console",
	network: "Network",
	errors: "Errors",
	events: "Events",
} satisfies Record<SessionEventTab, string>

/**
 * "Something went wrong here" across the three shapes it arrives in: an
 * `error` row, a console row at `error` level, and a request that came back
 * 4xx/5xx. The Errors tab, the red markers and the 3 s seek lead all key off
 * this one predicate so they cannot disagree about what an error is.
 */
export function isErrorEvent(event: SessionTranscriptOutput): boolean {
	return (
		event.type === "error" ||
		(event.type === "console" && event.level === "error") ||
		(event.type === "network" && event.netStatus >= 400)
	)
}

/** Whether an event belongs on a tab. `all` takes everything. */
export function matchesTab(event: SessionTranscriptOutput, tab: SessionEventTab): boolean {
	switch (tab) {
		case "all":
			return true
		case "console":
			return event.type === "console"
		case "network":
			return event.type === "network"
		case "errors":
			return isErrorEvent(event)
		case "events":
			return event.type === "custom"
	}
}

export function eventsForTab(
	events: ReadonlyArray<SessionTranscriptOutput>,
	tab: SessionEventTab,
): ReadonlyArray<SessionTranscriptOutput> {
	return tab === "all" ? events : events.filter((event) => matchesTab(event, tab))
}

/**
 * One pass for every tab's badge. A console row at `error` level is counted
 * twice — once as console, once as an error — because it genuinely appears on
 * both lists, and a count that disagreed with the list under it is worse than
 * two counts that sum past the total.
 */
export function tabCounts(events: ReadonlyArray<SessionTranscriptOutput>): Record<SessionEventTab, number> {
	const counts = { all: 0, console: 0, network: 0, errors: 0, events: 0 } satisfies Record<
		SessionEventTab,
		number
	>
	for (const event of events) {
		for (const tab of SESSION_EVENT_TABS) {
			if (matchesTab(event, tab)) counts[tab] += 1
		}
	}
	return counts
}

// The playhead

/**
 * The row the playhead is inside: the last entry at or before `playheadMs`.
 * `-1` before the first one, which is a real state — the recording can open on
 * frames that precede every distilled event.
 *
 * Offsets are not assumed sorted (a transcript ordered by `Seq` can carry two
 * rows on the same millisecond), so this takes the latest qualifying offset
 * rather than the first index that overshoots.
 */
export function currentIndexAt(offsetsMs: ReadonlyArray<number>, playheadMs: number): number {
	let best = -1
	let bestOffset = Number.NEGATIVE_INFINITY
	for (let i = 0; i < offsetsMs.length; i++) {
		const offset = offsetsMs[i]!
		if (!Number.isFinite(offset) || offset > playheadMs) continue
		if (offset >= bestOffset) {
			best = i
			bestOffset = offset
		}
	}
	return best
}

export interface UrlAtOffset {
	readonly offsetMs: number
	readonly url: string
}

/**
 * The URL the fake address bar shows: the latest navigation at or before the
 * playhead, falling back to the session's entry URL before the first one. A
 * navigation with an empty URL is skipped rather than blanking the bar.
 */
export function urlAt(navigations: ReadonlyArray<UrlAtOffset>, playheadMs: number, fallback: string): string {
	const usable = navigations.filter((entry) => entry.url !== "")
	const index = currentIndexAt(
		usable.map((entry) => entry.offsetMs),
		playheadMs,
	)
	return index === -1 ? fallback : usable[index]!.url
}

// Labels

/** `+120ms` / `+3.4s` from the session's start — the transcript's own clock. */
export function offsetLabel(startTime: string, timestamp: string): string {
	const start = parseChTime(startTime)
	const at = parseChTime(timestamp)
	if (Number.isNaN(start) || Number.isNaN(at)) return ""
	const deltaMs = Math.max(0, at - start)
	return deltaMs < 1000 ? `+${deltaMs}ms` : `+${(deltaMs / 1000).toFixed(1)}s`
}

/**
 * A custom event's `track()` properties, decoded from the serialized
 * `Attributes` map.
 *
 * `parseAttributes` is the app's one boundary for a warehouse `Map(String,
 * String)` — it owns the JSON parse and the "not an object" fallback. The only
 * thing left here is that a JSON array decodes to an object with index keys,
 * which would render `0`/`1` as property names; an event whose attributes are
 * an array has no properties, not two.
 */
export function customProperties(event: SessionTranscriptOutput): ReadonlyArray<readonly [string, string]> {
	const parsed = parseAttributes(event.attributes)
	if (Array.isArray(parsed)) return []
	return Object.entries(parsed).map(([key, value]) => [key, value] as const)
}
