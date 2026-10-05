import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { boundsKey, executeLocalCompiledQuery, localParams } from "@/lib/query"
import type { ProjectScope } from "../lib/project-scope"
import type { TimeBounds } from "../lib/time"
import { useNamespace } from "./use-namespace"

interface NamespaceServicesData {
	readonly namespace: string
	readonly services: ReadonlyArray<string>
}

/**
 * The header project as the list of services that reported it in the page's
 * window — what every view that cannot filter on `service.namespace` itself
 * (logs, errors, sessions, metrics, analytics, the service map) filters on.
 *
 * Keyed on the window, so a project's services are the ones active in what the
 * page shows. `keepPreviousData` covers a refresh or range change within the
 * same project: the previous window's list keeps dependent queries running
 * rather than blanking the page, and they re-run if the new list differs. A
 * list left over from a *different* project never counts — the result carries
 * the namespace it was asked for and is ignored when that is not the current
 * one.
 */
export function useNamespaceServices(bounds: TimeBounds): ProjectScope {
	const [namespace] = useNamespace()
	const query = useQuery<NamespaceServicesData>({
		queryKey: ["local", "namespace-services", namespace ?? null, boundsKey(bounds)],
		staleTime: 60_000,
		placeholderData: keepPreviousData,
		queryFn: namespace
			? async ({ signal }) => {
					const rows = await executeLocalCompiledQuery(
						CH.compile(CH.namespaceServicesQuery({ namespace }), localParams(bounds)),
						signal,
					)
					return { namespace, services: rows.map((row) => row.serviceName) }
				}
			: skipToken,
	})

	if (!namespace) return { namespace, services: undefined, isPending: false, error: null }
	const current = query.data?.namespace === namespace ? query.data : undefined
	return {
		namespace,
		services: current?.services,
		isPending: current === undefined,
		error: current === undefined ? query.error : null,
	}
}
