import { useCallback } from "react"
import type { InternalTrafficMode as EngineMode } from "@maple/query-engine/ch"
import {
	engineInternalTraffic,
	internalTrafficParam,
	persistInternalTraffic,
	resolveInternalTraffic,
	type InternalTrafficMode,
} from "../lib/internal-traffic"
import { useQueryParams } from "../lib/router"

/**
 * The internal-traffic mode: URL first, remembered choice second, written to
 * both (see `use-hide-health-checks.ts`, which this mirrors).
 */
export function useInternalTraffic(): readonly [InternalTrafficMode, (mode: InternalTrafficMode) => void] {
	const [query, setParams] = useQueryParams()
	const mode = resolveInternalTraffic(query.get("internal"))
	const setMode = useCallback(
		(next: InternalTrafficMode) => {
			persistInternalTraffic(next)
			setParams({ internal: internalTrafficParam(next) })
		},
		[setParams],
	)
	return [mode, setMode] as const
}

/**
 * The mode as the query engine's option, for the session data hooks.
 *
 * Read by those hooks themselves rather than threaded through every call site:
 * like the environment it is a page-wide scope, and every session, analytics
 * and home block must agree on it or counts side by side would describe
 * different populations.
 */
export function useInternalTrafficFilter(): EngineMode | undefined {
	return engineInternalTraffic(useInternalTraffic()[0])
}
