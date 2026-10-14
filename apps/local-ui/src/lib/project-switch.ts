// What survives a change of the header project.
//
// A project is the subject of the whole session, so switching it starts the
// page over: every page-level filter (a sidebar service, facets, attribute
// filters, search, tags, an open log or peeked trace) was chosen about the old
// project's data and is dropped. Only the standing choices carry across:
//
//   - `range` — the time window is about when, not what;
//   - `mode` / `view` — how a page is laid out (Logs list vs patterns, a
//     trace's waterfall vs flow), not a filter;
//   - `health=1` — the traces "show health checks" exception, a standing
//     preference. Other `health` values are the services page's health facet,
//     a filter, and go with the rest;
//   - `env` — kept when the new project reports that environment, so switching
//     products keeps you in production; dropped when it does not, rather than
//     leaving an environment selected that matches nothing.

const STANDING_PARAMS = ["range", "mode", "view"] as const
const HEALTH_TOGGLE_SHOWN = "1"

/** The query string after switching to `namespace` (`undefined` = all projects). */
export function paramsAfterProjectChange(
	current: URLSearchParams,
	namespace: string | undefined,
	keepEnvironment: boolean,
): URLSearchParams {
	const next = new URLSearchParams()
	for (const key of STANDING_PARAMS) {
		const value = current.get(key)
		if (value) next.set(key, value)
	}
	if (current.get("health") === HEALTH_TOGGLE_SHOWN) next.set("health", HEALTH_TOGGLE_SHOWN)
	const environment = current.get("env")
	if (environment && keepEnvironment) next.set("env", environment)
	// "All projects" is no `ns` at all, as `namespaceParam` writes it.
	if (namespace) next.set("ns", namespace)
	return next
}
