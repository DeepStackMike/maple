import { useCallback, useEffect } from "react"
import {
	environmentParam,
	persistEnvironment,
	resolveEnvironment,
	storedEnvironment,
} from "../lib/environment"
import { useQueryParams } from "../lib/router"

/**
 * The active deployment environment for the current view, and a setter.
 *
 * The exact shape of {@link useNamespace}, over the `env` param: read from the
 * URL first and the remembered preference second, written to both — the hash so
 * the view stays a link, `localStorage` so the next `maple start` opens on the
 * environment this one was left on.
 *
 * The resolved value is mirrored back into the URL for the reason the project
 * filter is: five views read `env` from the hash directly as their sidebar
 * facet, so leaving the preference implicit would mean the header saying
 * `production` while Traces below it showed every environment. The mirror is a
 * `replace`, so it normalizes the URL without adding a history entry.
 */
export function useEnvironment(): readonly [string | undefined, (next: string | undefined) => void] {
	const [query, setParams] = useQueryParams()
	const param = query.get("env")
	const environment = resolveEnvironment(param)

	useEffect(() => {
		// Only ever writes what the reader already chose, and only when the URL is
		// silent — a link that says `env=` (or says nothing while nothing is
		// stored) is left exactly as it arrived.
		if (!param && storedEnvironment()) setParams({ env: environmentParam(environment) })
	}, [param, environment, setParams])

	const setEnvironment = useCallback(
		(next: string | undefined) => {
			persistEnvironment(next)
			setParams({ env: environmentParam(next) })
		},
		[setParams],
	)

	return [environment, setEnvironment] as const
}
