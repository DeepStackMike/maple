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
// WHICH VIEWS HONOUR IT (2026-10, keep this list current): every list view.
//
// Two mechanisms, because only spans carry `service.namespace` everywhere:
//
//   1. On the namespace itself, where the builder can:
//      - Traces list + its facets — `useLocalTraces` / `useLocalTraceFacets`.
//      - Services list — reads `ns` from the URL, which the mirroring in
//        `useNamespace` keeps populated.
//      - Home: the Services table + the Spans/Error rate/p95/Services KPIs (via
//        `serviceCatalogQuery`), and the throughput/error-rate chart (via
//        `tracesTimeseriesQuery`'s `namespaces`, which routes off the hourly
//        rollup — it carries no `ServiceNamespace` — and onto the entry-point
//        projection, which does).
//
//   2. As the project's services, everywhere else. `useNamespaceServices`
//      resolves the project to the services that reported it in the page's
//      window (`namespaceServicesQuery`, which reads the namespace off spans,
//      logs, sessions and metrics alike), and the view filters on that list,
//      intersected with its own service filter (`lib/project-scope.ts`; a
//      sidebar service outside the project yields nothing). Dependent queries
//      stay disabled until the list is known, so a page never flashes another
//      project's rows.
//      - Logs: list, histogram and every facet (`serviceNames`).
//      - Errors: KPIs, list, facets (the Service facet narrowed client-side),
//        sparks, version comparison, a row's traces (`services`).
//      - Sessions: list + facets (`services`). Session detail needs nothing —
//        it is one session, reached from a list that was already scoped.
//      - Metrics: list, summary, sparklines, and a metric's entry, chart and
//        breakdown (`services`).
//      - Analytics: every Web card incl. regions/cities, every Product query and
//        the funnel (`services` in the filters, through the `session_replays`
//        semi-join).
//      - Service map: filtered client-side (`scopeServiceMap`) — nodes to the
//        project's services, and an edge kept when either end is in the project.
//      - Home: the Sessions/Errors KPIs and the recent errors/sessions blocks.
//
//   THE ONE CAVEAT of (2): it maps by service *name*. A service name reported by
//   two projects belongs to both, so its rows show under either. The Harbr
//   naming convention (`<namespace>-<component>`) keeps names unique, and the
//   views in (1) stay exact regardless.
//
//   One small gap remains: a metric's attribute-key / value suggestions in the
//   filter bar are unscoped (suggestions only; the chart they filter is scoped).

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
