import { useCallback } from "react"
import { internalParam, persistHideInternal, resolveHideInternal } from "../lib/internal-traffic"
import { useQueryParams } from "../lib/router"

/**
 * The "Hide internal" choice: URL first, remembered preference second, written
 * to both (see `use-hide-health-checks.ts`, which this mirrors).
 *
 * Read by the session data hooks themselves rather than threaded through every
 * call site: like the environment it is a page-wide scope, and every session,
 * analytics and home block must agree on it or the counts beside each other
 * would describe different populations.
 */
export function useHideInternal(): readonly [boolean, (hide: boolean) => void] {
	const [query, setParams] = useQueryParams()
	const hidden = resolveHideInternal(query.get("internal"))
	const setHidden = useCallback(
		(next: boolean) => {
			persistHideInternal(next)
			setParams({ internal: internalParam(next) })
		},
		[setParams],
	)
	return [hidden, setHidden] as const
}
