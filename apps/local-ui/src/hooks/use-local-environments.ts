import { useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { ENVIRONMENT_LOOKBACK_RANGE } from "../lib/environment"
import { boundsForRange } from "../lib/time"

/**
 * The deployment environments to offer in the header selector, alphabetically.
 *
 * `serviceEnvironmentsQuery` with no `serviceName` is the organization-wide
 * list, read off the service-overview windows rather than a raw `traces` scan,
 * and it already drops the empty environment — which is what an unset
 * `deployment.environment.name` looks like, and which would otherwise be
 * offered as a nameless choice that filters to nothing.
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
			const rows = await executeLocalCompiledQuery(
				CH.compile(CH.serviceEnvironmentsQuery(), { orgId: LOCAL_ORG_ID, startTime, endTime }),
			)
			return rows.map((row) => row.environment)
		},
	})
}
