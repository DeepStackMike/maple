// Hiding health-check traffic.
//
// A liveness probe is the highest-QPS route a local service has and the least
// interesting: on a dev machine with one browser tab open, `/health` every
// second is most of the Traces list and the top row of every service's
// operations table. Nothing about it is a bug, so the list's job is to not show
// it — but "not shown" and "not there" are different claims, which is why this
// is a toggle with a link-shaped off switch rather than a hardcoded filter.

/**
 * The probe routes, as `ILIKE` patterns for the query engine's
 * `excludeNamePatterns`.
 *
 * Substrings of a route, not route names: a probe reaches the warehouse as
 * `GET /health`, as `/api/health`, and as a raw span name with the route in an
 * attribute, and one pattern covers all three. `%/healthz%` and `%/api/health%`
 * are deliberately absent — `%/health%` already matches both, and a pattern
 * that can never be the only one to match is a term in every generated WHERE
 * for nothing.
 *
 * `/live` and `/ready` are the Kubernetes spellings; `/api/telemetry` is
 * Maple's own SDK beacon, which a page instrumented with `@maple-dev/browser`
 * posts to on a timer and which would otherwise dominate its own trace list.
 */
export const HEALTH_CHECK_PATTERNS: ReadonlyArray<string> = [
	"%/health%",
	"%/ready%",
	"%/live%",
	"%/ping%",
	"%/api/telemetry%",
]

/** Hidden unless the reader says otherwise — the probes are noise by default. */
export const DEFAULT_HIDE_HEALTH_CHECKS = true

export const HIDE_HEALTH_CHECKS_KEY = "maple.local.hideHealthChecks"

/**
 * The remembered preference, or `undefined` when there is none to read.
 *
 * Guarded because `localStorage` is a getter that throws in a sandboxed iframe
 * and is absent under the test runner's node environment — neither is a reason
 * for a list not to render.
 */
export function storedHideHealthChecks(): boolean | undefined {
	try {
		const raw = globalThis.localStorage?.getItem(HIDE_HEALTH_CHECKS_KEY)
		return raw === "true" ? true : raw === "false" ? false : undefined
	} catch {
		return undefined
	}
}

/** Remember the choice for the next visit. Failure to store is not failure to toggle. */
export function persistHideHealthChecks(hide: boolean): void {
	try {
		globalThis.localStorage?.setItem(HIDE_HEALTH_CHECKS_KEY, hide ? "true" : "false")
	} catch {
		// A storage quota or a blocked origin: the toggle still applies to this view.
	}
}

/**
 * Whether to hide the probes, given the URL's `health` param.
 *
 * The param wins over the stored preference, because it is the more specific
 * statement: a link someone pasted says what *that view* should show, and
 * resolving it against the recipient's own setting would make the same URL two
 * different pages. Absent, the stored preference answers, and absent that, the
 * default.
 *
 * `health=1` shows them — the param names the exception, so a shared link to
 * the ordinary view carries no query string at all.
 */
export function resolveHideHealthChecks(param: string | null | undefined): boolean {
	if (param === "1") return false
	if (param === "0") return true
	return storedHideHealthChecks() ?? DEFAULT_HIDE_HEALTH_CHECKS
}

/** The `health` param for a choice — `null` clears it, which is the default view. */
export function healthCheckParam(hide: boolean): string | null {
	return hide ? null : "1"
}

/** The builder option for a choice: no patterns at all when the probes are wanted. */
export function healthCheckPatterns(hide: boolean): ReadonlyArray<string> | undefined {
	return hide ? HEALTH_CHECK_PATTERNS : undefined
}
