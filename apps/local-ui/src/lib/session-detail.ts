// The session page's arithmetic, kept out of the view.
//
// Everything here is a pure function over the distilled transcript
// (`session_events`) and the playback clock. The view renders; this file
// decides what "active", "the current row" and "the page the user was on"
// mean, so those three answers are testable without a DOM or an rrweb player.

import { parseAttributes } from "@maple/ui/lib/span-tree"
import { normalizeSpanKind } from "@maple/ui/lib/span-kind"
import type { SessionSpanOutput, SessionTranscriptOutput } from "@maple/query-engine/ch"

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

// Transcript row → backend trace

/**
 * A transcript row's identity on the page: the scrubber marker it owns, the
 * `data-transcript-id` the panel scrolls to, and the key every map here is
 * built on. `Seq` alone would do for a single session, but the timestamp costs
 * nothing and makes the id readable in the DOM.
 */
export const transcriptRowId = (event: SessionTranscriptOutput): string => `${event.seq}-${event.timestamp}`

/**
 * How far either side of a transcript row a span may start and still be the
 * same request.
 *
 * `session_events.Timestamp` is stamped by `Date.now()` in the page at the
 * moment the row is emitted, and the span's start comes off the exporter's
 * clock on another machine — so the two disagree by the page's own clock skew
 * plus however long the request spent in flight. Two seconds covers both
 * without reaching the next request to the same endpoint in any interaction a
 * human performs; widening it is how you get a click's fetch matched to the
 * poll that fired before it.
 */
export const SPAN_MATCH_WINDOW_MS = 2000

/**
 * A span's start as epoch milliseconds.
 *
 * `startTimeNs` is a decimal STRING of nanoseconds — 1.7e18, far above 2^53 —
 * so the milliseconds come off the leading digits rather than from
 * `Number(ns) / 1e6`, which would round the value before the division. Falls
 * back to the rendered datetime when the nanosecond field is missing or is not
 * a bare integer.
 */
export function spanStartMs(span: SessionSpanOutput): number {
	const ns = span.startTimeNs
	if (/^\d{7,}$/.test(ns)) return Number(ns.slice(0, -6))
	return parseChTime(span.startTime)
}

/**
 * The path of a URL, absolute or relative.
 *
 * The transcript records whatever string the page passed to `fetch` — often
 * `/api/thing` — while a span carries the resolved absolute URL, so the two are
 * only ever comparable on the path. The placeholder origin exists to let
 * `URL` parse the relative case; it never escapes this function. A trailing
 * slash is dropped (except on the root) so `/api/thing` and `/api/thing/` are
 * the one endpoint they plainly are.
 */
export function urlPath(url: string): string {
	if (!url) return ""
	let path: string
	try {
		path = new URL(url, "http://session.local").pathname
	} catch {
		// Not parseable as a URL at all: take everything before the query/hash and
		// hope it was a path. A malformed row should not throw the whole panel.
		path = url.split(/[?#]/)[0] ?? ""
	}
	return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path
}

/** Full-URL comparison key: the URL without its fragment, which no span carries. */
function urlKey(url: string): string {
	return url.split("#")[0] ?? ""
}

/**
 * How good a URL match is: 0 for the same URL, 1 for the same path, `undefined`
 * for neither. Exactness is a tie-breaker, not a requirement — the common case
 * is a relative `net_url` against an absolute `url.full`, which can only ever
 * match on the path.
 */
function urlRank(eventUrl: string, spanUrl: string): number | undefined {
	if (!eventUrl) return undefined
	if (spanUrl && urlKey(eventUrl) === urlKey(spanUrl)) return 0
	const path = urlPath(eventUrl)
	if (path && path === urlPath(spanUrl)) return 1
	return undefined
}

interface Candidate {
	readonly span: SessionSpanOutput
	/** Preference order, compared left to right; the first difference wins. */
	readonly rank: ReadonlyArray<number>
}

function best(candidates: ReadonlyArray<Candidate>): SessionSpanOutput | undefined {
	let winner: Candidate | undefined
	for (const candidate of candidates) {
		if (winner === undefined || compareRanks(candidate.rank, winner.rank) < 0) winner = candidate
	}
	return winner?.span
}

function compareRanks(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0)
		if (diff !== 0) return diff
	}
	return 0
}

/**
 * The span a `network` transcript row was — when the row itself lost the trace
 * id.
 *
 * Three facts have to agree: the method, the URL (exactly, or on its path), and
 * the time to within {@link SPAN_MATCH_WINDOW_MS}. Among the spans that satisfy
 * all three the browser's own CLIENT span wins, because it is the top of the
 * trace and the one the request actually *is*; a SERVER span is the fallback
 * for a request whose client span was never exported (fetch instrumentation
 * off, or a `sendBeacon`). Kinds other than those two are not requests and are
 * never candidates.
 *
 * Ties break towards the exact URL, then the closest start, then the earliest —
 * so a page that polls one endpoint resolves to a stable answer rather than
 * whichever row the warehouse happened to return first.
 */
export function matchNetworkSpan(
	event: SessionTranscriptOutput,
	spans: ReadonlyArray<SessionSpanOutput>,
	windowMs: number = SPAN_MATCH_WINDOW_MS,
): SessionSpanOutput | undefined {
	const at = parseChTime(event.timestamp)
	if (Number.isNaN(at) || !event.netUrl) return undefined
	const method = event.netMethod.toUpperCase()

	const candidates: Candidate[] = []
	for (const span of spans) {
		const kind = normalizeSpanKind(span.kind)
		const kindRank = kind === "CLIENT" ? 0 : kind === "SERVER" ? 1 : undefined
		if (kindRank === undefined) continue
		if (!span.httpMethod || span.httpMethod.toUpperCase() !== method) continue
		const url = urlRank(event.netUrl, span.httpUrl)
		if (url === undefined) continue
		const start = spanStartMs(span)
		if (Number.isNaN(start)) continue
		const delta = Math.abs(start - at)
		if (delta > windowMs) continue
		candidates.push({ span, rank: [kindRank, url, delta, start] })
	}
	return best(candidates)
}

/**
 * The span an `error` transcript row belongs to, when the row lost its trace
 * id.
 *
 * Nothing about a browser exception names a request, so the only usable
 * predicate is "a span of this session that failed at about this moment" —
 * which is exactly the case worth linking: a throw in the page whose cause was
 * a 500 the backend recorded. A failing span is required, not preferred: the
 * nearest *successful* span to an exception is almost always an unrelated
 * request that happened to be in flight, and offering it as "the trace" would
 * be a confident wrong answer.
 */
export function matchErrorSpan(
	event: SessionTranscriptOutput,
	spans: ReadonlyArray<SessionSpanOutput>,
	windowMs: number = SPAN_MATCH_WINDOW_MS,
): SessionSpanOutput | undefined {
	const at = parseChTime(event.timestamp)
	if (Number.isNaN(at)) return undefined

	const candidates: Candidate[] = []
	for (const span of spans) {
		if (span.statusCode !== "Error") continue
		const start = spanStartMs(span)
		if (Number.isNaN(start)) continue
		const delta = Math.abs(start - at)
		if (delta > windowMs) continue
		candidates.push({ span, rank: [delta, start] })
	}
	return best(candidates)
}

/**
 * Every recovered row→span link for a transcript, keyed by
 * {@link transcriptRowId}.
 *
 * Only rows that lost their trace id are matched. A row that carries one needs
 * no recovery and must not get one: the id the SDK recorded is the truth, and a
 * heuristic that disagreed with it would be strictly worse.
 */
export function recoverTraceLinks(
	events: ReadonlyArray<SessionTranscriptOutput>,
	spans: ReadonlyArray<SessionSpanOutput>,
	windowMs: number = SPAN_MATCH_WINDOW_MS,
): ReadonlyMap<string, SessionSpanOutput> {
	const links = new Map<string, SessionSpanOutput>()
	if (spans.length === 0) return links
	for (const event of events) {
		if (event.traceId) continue
		const span =
			event.type === "network"
				? matchNetworkSpan(event, spans, windowMs)
				: event.type === "error"
					? matchErrorSpan(event, spans, windowMs)
					: undefined
		if (span) links.set(transcriptRowId(event), span)
	}
	return links
}

export interface TraceLink {
	readonly traceId: string
	/** True when the id was inferred from session + URL + time, not recorded on the row. */
	readonly matched: boolean
}

/** The trace a row links to: its own id when it has one, else a recovered match. */
export function traceLinkFor(
	event: SessionTranscriptOutput,
	recovered: ReadonlyMap<string, SessionSpanOutput>,
): TraceLink | undefined {
	if (event.traceId) return { traceId: event.traceId, matched: false }
	const span = recovered.get(transcriptRowId(event))
	return span ? { traceId: span.traceId, matched: true } : undefined
}

/**
 * The session's correlated trace ids: the ones its ended metadata row recorded,
 * plus the ones only the spans know about.
 *
 * `session_replays.TraceIds` is written by the unload beacon, so an active
 * session — or one whose tab was closed before the beacon flushed — has none at
 * all. The spans carry `session.id` from the moment they start, so they answer
 * for both. Recorded ids keep their place at the front; the recovered ones
 * follow in the order the spans arrived, and the summaries query re-sorts the
 * whole set by time anyway.
 */
export function unionTraceIds(
	recorded: ReadonlyArray<string>,
	spans: ReadonlyArray<SessionSpanOutput>,
): ReadonlyArray<string> {
	const seen = new Set<string>()
	const ids: string[] = []
	for (const id of recorded) {
		if (!id || seen.has(id)) continue
		seen.add(id)
		ids.push(id)
	}
	for (const span of spans) {
		if (!span.traceId || seen.has(span.traceId)) continue
		seen.add(span.traceId)
		ids.push(span.traceId)
	}
	return ids
}

/**
 * Padding either side of the session when asking the warehouse for its spans.
 *
 * The bounds exist to prune daily partitions, not to be exact: a span started
 * by the page's last request can land after the session's own end time, and the
 * two clocks disagree anyway. A minute costs nothing at partition granularity
 * and is the difference between finding that span and not.
 */
export const SPAN_WINDOW_PAD_MS = 60_000

export interface SessionSpanWindow {
	readonly startMs: number
	readonly endMs: number
}

/**
 * The time window to fetch a session's spans over.
 *
 * An active session has no end time — the unload beacon that writes one has not
 * fired — so the window runs to now, which is also the case where the recovered
 * link matters most: nothing has written `TraceIds` yet either.
 *
 * Both ends are rounded to the minute, and `now` is floored to the minute
 * before it is used, so the window — and the query key built from it — is the
 * same for every render within a minute. An unrounded `now` would make every
 * render a cache miss and every cache miss a new query.
 */
export function sessionSpanWindow(
	session: {
		readonly startTime: string
		readonly endTime: string | null
		readonly durationMs: number | null
	},
	nowMs: number = Date.now(),
): SessionSpanWindow | undefined {
	const start = parseChTime(session.startTime)
	if (Number.isNaN(start)) return undefined
	const minute = 60_000
	const ended = parseChTime(session.endTime)
	const end = Number.isFinite(ended)
		? ended
		: session.durationMs !== null
			? start + session.durationMs
			: // Floored, not raw: an active session's end IS now, and a `now` that
				// moves every millisecond moves the window with it.
				Math.floor(nowMs / minute) * minute
	return {
		startMs: Math.floor((start - SPAN_WINDOW_PAD_MS) / minute) * minute,
		endMs: Math.ceil((Math.max(end, start) + SPAN_WINDOW_PAD_MS) / minute) * minute,
	}
}
