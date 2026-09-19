// The project filter.
//
// One machine runs several projects at once — that is a local Maple's whole
// reason to exist — and they all report to the same binary under the same org.
// `service.namespace` is how an OpenTelemetry resource says which project a
// service belongs to, and without it two projects that both have a service
// called `api` are one indistinguishable list.
//
// So: a standing choice, like the time range and the health-check toggle, and
// not a facet. A facet lists what the data contains and counts it; this one
// says what the whole session is *about*, which is why it lives in the header
// rather than in one view's sidebar, and why it is remembered across restarts.
//
// WHICH VIEWS HONOUR IT (2026-09, keep this list current):
//   - Traces list + its facets — `useLocalTraces` / `useLocalTraceFacets`
//     already took `ns`; the header now supplies it when the sidebar does not.
//   - Services list — reads `ns` from the URL on its own, which the mirroring
//     below keeps populated.
//   - Home: the Services table + the Spans/Error rate/p95/Services KPIs (via
//     `serviceCatalogQuery`), and the throughput/error-rate chart (via
//     `tracesTimeseriesQuery`'s `namespaces`, which routes off the hourly
//     rollup — it carries no `ServiceNamespace` — and onto the entry-point
//     projection, which does).
//   - Home: errors and sessions blocks are NOT filtered and say so. `error_events`
//     and `session_replays` carry no namespace dimension their builders expose,
//     so filtering them would mean either a wrong number or a new query.
// Errors, Logs, Sessions and the Service map are unfiltered for the same
// reason: their builders take no namespace today. Each is a matter of threading
// `namespaces` (or the equivalent) through the hook that owns it — the param
// and the stored preference are already global.

/** The `localStorage` key. `""` is stored for an explicit "All projects". */
export const NAMESPACE_KEY = "maple.local.namespace"

/**
 * The remembered project, or `undefined` for "all".
 *
 * Guarded because `localStorage` is a getter that throws in a sandboxed iframe
 * and is absent under the test runner's node environment — neither is a reason
 * for a header not to render. "Nothing stored" and "stored as all projects"
 * both come back `undefined` on purpose: the default is all projects, so the
 * two are the same answer and a tri-state would be a distinction with no
 * consequence.
 */
export function storedNamespace(): string | undefined {
	try {
		return globalThis.localStorage?.getItem(NAMESPACE_KEY) || undefined
	} catch {
		return undefined
	}
}

/** Remember the choice for the next `maple start`. Failure to store is not failure to filter. */
export function persistNamespace(namespace: string | undefined): void {
	try {
		globalThis.localStorage?.setItem(NAMESPACE_KEY, namespace ?? "")
	} catch {
		// A storage quota or a blocked origin: the choice still applies to this session.
	}
}

/**
 * The active project, given the URL's `ns` param.
 *
 * The param wins, because it is the more specific statement: a link someone
 * pasted says which project *that view* is showing, and resolving it against
 * the recipient's own preference would make one URL two different pages.
 * Absent, the stored preference answers, and absent that, all projects.
 */
export function resolveNamespace(param: string | null | undefined): string | undefined {
	return param || storedNamespace()
}

/** The `ns` param for a choice — `null` clears it, which is all projects. */
export function namespaceParam(namespace: string | undefined): string | null {
	return namespace || null
}

/**
 * The builder option for a choice: no filter at all for all projects, so the
 * unfiltered view emits exactly the SQL it emitted before this existed.
 */
export function namespaceFilter(namespace: string | undefined): ReadonlyArray<string> | undefined {
	return namespace ? [namespace] : undefined
}

/** Shown in the selector for the absence of a choice. */
export const ALL_PROJECTS_LABEL = "All projects"

/**
 * How far back the selector looks for projects to offer.
 *
 * Wider than any view's default range on purpose: a project that has been idle
 * since this morning must still be selectable, or the filter can only ever
 * offer whatever is already visible. Not the widest either — a namespace that
 * has reported nothing in a week is a project the reader has moved on from, and
 * listing it costs a scan and a line in a dropdown to filter to an empty page.
 */
export const NAMESPACE_LOOKBACK_RANGE = "7d"
