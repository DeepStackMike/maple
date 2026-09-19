import { useCallback } from "react"
import { healthCheckParam, persistHideHealthChecks, resolveHideHealthChecks } from "../lib/health-checks"
import { useQueryParams } from "../lib/router"

/**
 * The "Hide health checks" choice for the current view.
 *
 * Read from the URL first and the remembered preference second; written to both
 * — the hash so the view stays a link, `localStorage` so the next `maple start`
 * opens the way this one was left. Two stores for one boolean because they
 * answer different questions: the URL says what *this page* shows, the
 * preference says what a page with nothing to say about it should show.
 */
export function useHideHealthChecks(): readonly [boolean, (hide: boolean) => void] {
	const [query, setParams] = useQueryParams()
	const hidden = resolveHideHealthChecks(query.get("health"))
	const setHidden = useCallback(
		(next: boolean) => {
			persistHideHealthChecks(next)
			setParams({ health: healthCheckParam(next) })
		},
		[setParams],
	)
	return [hidden, setHidden] as const
}
