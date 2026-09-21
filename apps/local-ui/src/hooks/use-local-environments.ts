import { useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { ENVIRONMENT_LOOKBACK_RANGE } from "../lib/environment"
import { boundsForRange } from "../lib/time"

/**
 * Both lists as one, deduplicated and alphabetical — the order the selector
 * renders. Exported for its test: the merge is the only logic in this hook, and
 * the interesting case (the same environment reported by spans and by sessions)
 * is invisible from a query-level test.
 */
export function mergeEnvironments(...lists: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> {
	return [...new Set(lists.flat())].sort()
}

/**
 * The deployment environments to offer in the header selector, alphabetically.
 *
 * `serviceEnvironmentsQuery` with no `serviceName` is the organization-wide
 * list, read off the service-overview windows rather than a raw `traces` scan.
 * It projects `DeploymentEnv` through `envLabel`, so the empty environment —
 * what an unset `deployment.environment.name` looks like — arrives as `unknown`
 * rather than as a nameless choice that would have filtered to nothing. The
 * option appears only when something in the lookback actually lacks the
 * attribute, because it is a GROUP BY over the rows themselves.
 *
 * Two queries, unioned. The service list is built from spans, and a browser
 * session is not a span: a Maple whose only untagged telemetry is its recorded
 * sessions — the usual shape, since the browser SDK has no process environment
 * to read off — would be offered no `unknown` at all, while the Sessions list
 * sat full of rows no environment could reach. `sessionEnvironmentsQuery` is
 * the other half, and the same argument covers a browser-only `staging`.
 *
 * Deliberately not keyed on the view's range, exactly as
 * {@link useLocalNamespaces} is not: the selector names every environment this
 * Maple has seen recently, and narrowing it to the current window would make
 * the list shrink as the reader zooms in. One cache entry for the session.
 */
export function useLocalEnvironments() {
	return useQuery<ReadonlyArray<string>>({
		queryKey: ["local", "environments"],
		// A dev machine grows a new environment when something new is started, not
		// between clicks.
		staleTime: 5 * 60_000,
		queryFn: async () => {
			const { startTime, endTime } = boundsForRange(ENVIRONMENT_LOOKBACK_RANGE)
			const params = { orgId: LOCAL_ORG_ID, startTime, endTime }
			const [services, sessions] = await Promise.all([
				executeLocalCompiledQuery(CH.compile(CH.serviceEnvironmentsQuery(), params)),
				executeLocalCompiledQuery(CH.compile(CH.sessionEnvironmentsQuery(), params)),
			])
			return mergeEnvironments(
				services.map((row) => row.environment),
				sessions.map((row) => row.environment),
			)
		},
	})
}
