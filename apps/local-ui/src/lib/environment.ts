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
// WHICH VIEWS HONOUR IT (2026-09, keep this list current):
//   - Traces, Logs, Errors, Services, Service map — each already filtered on
//     the `env` param; `useEnvironment`'s mirror keeps it populated, and
//     `switchTab` carries it from page to page.
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
// The one thing it cannot reach is a browser session recorded with no
// environment attribute at all: while a value is selected those sessions are
// out, the same way a country filter excludes a session with no country. On a
// local Maple that is the SDK or ingest sidecar not setting
// `deployment.environment.name` on the session's resource attributes.

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
 * How far back the selector looks for environments to offer.
 *
 * The same week `NAMESPACE_LOOKBACK_RANGE` uses, and for the same reason: an
 * environment that has been idle since this morning must still be selectable,
 * or the filter can only ever offer what is already on screen — and that is the
 * one moment the reader wants to switch to something they cannot currently see.
 */
export const ENVIRONMENT_LOOKBACK_RANGE = "7d"
