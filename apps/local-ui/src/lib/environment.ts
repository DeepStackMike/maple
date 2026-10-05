// The deployment-environment filter.
//
// The sibling of `lib/namespace.ts`, and deliberately built the same way. A
// namespace says which *project* the session is about; an environment says
// which *deployment* of it — `production`, `staging`, the throwaway one a
// script just seeded. Both are standing choices rather than facets: they say
// what the whole session is about, which is why they live in the header beside
// each other, are remembered across restarts, and are mirrored into the hash so
// every page is a link.
//
// **The param is `env`, which five views already read as their own sidebar
// facet** (traces, logs, errors, services, the service map). That is the same
// arrangement `ns` has with the services list, and it is the point rather than
// a collision: there is one `deployment.environment` dimension, so a header
// that says `production` and a sidebar that says `production` must be the same
// filter or one of them is lying. Those views keep their facet — it is how a
// value is discovered — and the header now supplies the value when the sidebar
// does not.
//
// WHICH VIEWS HONOUR IT (2026-10, keep this list current):
//   - Traces, Logs, Errors, Services — each already filtered on the `env`
//     param; `useEnvironment`'s mirror keeps it populated, and `switchTab`
//     carries it from page to page.
//   - Sessions — from `useEnvironment` (it has no environment facet).
//   - Service map — client-side (`scopeServiceMap`): overviews are per
//     (service, environment) so they filter exactly; edges carry no
//     environment, so they are only pruned by their ends and their counts
//     stay all-environment.
//   - Metrics: a metric's chart and breakdown (`environments`). NOT the metrics
//     list, summary or sparklines: the catalog rollup they read has no
//     environment column, and the list says "all environments" when one is
//     selected rather than pretending.
//   - Home: every block. The KPI strip and the services table via
//     `serviceCatalogQuery`'s `deploymentEnvironment`, the chart via
//     `tracesTimeseriesQuery`'s `environments`, recent errors via
//     `errorsByTypeQuery`'s `deploymentEnvs`, and the sessions tile + recent
//     sessions via the new `environment` option on the `session_replays`
//     builders. Unlike the namespace, no block on Home has to sit this out.
//   - Analytics, both sections. `session_replays` carries the environment in
//     its resource map, so the Web cards filter directly; `session_events` and
//     `product_events` carry none, and reach it through the `session_replays`
//     semi-join the builders already use for every other visitor-level
//     dimension (see `needsSessionSemiJoin`).
//
// TELEMETRY WITH NO ENVIRONMENT IS ITS OWN ENVIRONMENT: `unknown`. A span, log,
// error or session whose resource attributes carry no
// `deployment.environment.name` (nor the deprecated `deployment.environment`)
// used to sit outside every environment — the selector did not offer it and
// every filter excluded it, so the only way to see those rows was to clear the
// filter. The query engine now reads every environment column through
// `envLabel` (`packages/query-engine/src/ch/queries/environment.ts`), which maps
// the empty value to the literal `unknown` in the SELECT and in the WHERE
// alike; the selector offers it like any other environment and selecting it
// returns exactly those rows.
//
// It is a read-side name, not a fix. A service that should be tagged is still
// untagged — `unknown` only makes that visible, and the right answer is still to
// set the attribute (the ingest sidecar now stamps it on session meta rows).

import { UNKNOWN_ENVIRONMENT } from "@maple/query-engine/ch"

// Re-exported so the header, the views and the query engine all spell it the
// same way: it is the `env` URL param's value as much as it is a SQL literal.
export { UNKNOWN_ENVIRONMENT }

/** The `localStorage` key. `""` is stored for an explicit "All environments". */
export const ENVIRONMENT_KEY = "maple.local.environment"

/**
 * The remembered environment, or `undefined` for "all".
 *
 * Guarded exactly as {@link storedNamespace} is: `localStorage` is a getter
 * that throws in a sandboxed iframe and is absent under the test runner's node
 * environment, and neither is a reason for a header not to render.
 */
export function storedEnvironment(): string | undefined {
	try {
		return globalThis.localStorage?.getItem(ENVIRONMENT_KEY) || undefined
	} catch {
		return undefined
	}
}

/** Remember the choice for the next `maple start`. Failure to store is not failure to filter. */
export function persistEnvironment(environment: string | undefined): void {
	try {
		globalThis.localStorage?.setItem(ENVIRONMENT_KEY, environment ?? "")
	} catch {
		// A storage quota or a blocked origin: the choice still applies to this session.
	}
}

/**
 * The active environment, given the URL's `env` param.
 *
 * The param wins, for the same reason it does for the project: a pasted link
 * says which environment *that view* is showing, and resolving it against the
 * recipient's own preference would make one URL two different pages.
 */
export function resolveEnvironment(param: string | null | undefined): string | undefined {
	return param || storedEnvironment()
}

/** The `env` param for a choice — `null` clears it, which is all environments. */
export function environmentParam(environment: string | undefined): string | null {
	return environment || null
}

/** Shown in the selector for the absence of a choice. */
export const ALL_ENVIRONMENTS_LABEL = "All environments"

/**
 * The environment as the selector spells it.
 *
 * Only `unknown` is touched, and only here. Every other environment is a name
 * somebody chose — `production`, `staging`, `pr-4417` — and title-casing those
 * would be the header disagreeing with the sidebar facets, the URL and the
 * attribute itself. `unknown` is the one value Maple made up rather than read,
 * so it reads as a caption beside "All environments" while the param, the SQL
 * and the facet lists all keep the lower-case value.
 */
export function environmentLabel(environment: string): string {
	return environment === UNKNOWN_ENVIRONMENT ? "Unknown" : environment
}

/**
 * How far back the selector looks for environments to offer.
 *
 * The same week `NAMESPACE_LOOKBACK_RANGE` uses, and for the same reason: an
 * environment that has been idle since this morning must still be selectable,
 * or the filter can only ever offer what is already on screen — and that is the
 * one moment the reader wants to switch to something they cannot currently see.
 */
export const ENVIRONMENT_LOOKBACK_RANGE = "7d"
