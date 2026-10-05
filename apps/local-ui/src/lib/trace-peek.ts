// The traces list's peek: a trace opened in a sheet over the list rather than
// on its own page. Ported from the hosted app (#896). Local lists are one row
// per trace in both scopes, so the trace id alone pins a row — the hosted
// `peekRow` (per-span lists) and `peekT` (partition pruning) have no job here.

/** The URL params the peek owns: the peeked trace and the span selected inside it. */
export const PEEK_PARAM = "peek"
export const PEEK_SPAN_PARAM = "peekSpan"

export interface ResolvedPeek {
	readonly traceId: string
	/** Where the row sits in the loaded list; `null` when the URL names a trace that is not loaded. */
	readonly position: { readonly index: number; readonly count: number } | null
}

/**
 * Which row the URL's peek refers to, against the rows on screen. A peek whose
 * row is not loaded (a shared link past the first page, or a filter changed
 * under it) still opens from the id — just without a position, so the arrows
 * have nothing to step to.
 */
export function resolvePeek(
	rows: ReadonlyArray<{ readonly traceId: string }>,
	peek: string | null | undefined,
): ResolvedPeek | null {
	if (!peek) return null
	const index = rows.findIndex((row) => row.traceId === peek)
	return {
		traceId: peek,
		position: index === -1 ? null : { index, count: rows.length },
	}
}

/** The trace a step lands on, or `undefined` at either end (or with no position). */
export function stepTarget<R extends { readonly traceId: string }>(
	rows: ReadonlyArray<R>,
	peek: ResolvedPeek | null,
	delta: 1 | -1,
): R | undefined {
	if (!peek?.position) return undefined
	return rows[peek.position.index + delta]
}

/** ↓/J step forward, ↑/K back — the list idiom, mirrored in the sheet's footer. */
export function stepFor(key: string): 1 | -1 | undefined {
	switch (key) {
		case "ArrowDown":
		case "j":
		case "J":
			return 1
		case "ArrowUp":
		case "k":
		case "K":
			return -1
		default:
			return undefined
	}
}

/**
 * A primary-button click with no modifier: the only click the peek takes over.
 * ⌘/ctrl/shift/alt, middle and right click keep the row link's own behaviour
 * (new tab, new window, context menu).
 */
export function isPlainClick(event: {
	readonly button: number
	readonly metaKey: boolean
	readonly ctrlKey: boolean
	readonly shiftKey: boolean
	readonly altKey: boolean
}): boolean {
	return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

/** The list's query with the peek's params removed — what closing the sheet leaves behind. */
export function withoutPeek(query: URLSearchParams): URLSearchParams {
	const next = new URLSearchParams(query)
	next.delete(PEEK_PARAM)
	next.delete(PEEK_SPAN_PARAM)
	return next
}

/**
 * The full trace page's query for "Open trace": the list's filters minus the
 * peek, with the peek's selected span carried over as the page's `spanId`.
 */
export function openTraceQuery(query: URLSearchParams, spanId: string | undefined): URLSearchParams {
	const next = withoutPeek(query)
	if (spanId) next.set("spanId", spanId)
	else next.delete("spanId")
	return next
}
