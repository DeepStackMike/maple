// The header project, as the list of services that belong to it.
//
// Only spans and services can filter on `service.namespace` directly; errors,
// product events and the service-map edges know a row's service and nothing
// else. So every other view resolves the project to its services first
// (`namespaceServicesQuery`, through `useNamespaceServices`) and filters on
// that list. These are the pure halves of that: combining the project with a
// page's own service filter, and narrowing data that arrives unfiltered.
//
// `undefined` throughout means "no project selected — no filter at all", and
// an empty list means "a project with nothing in it — match nothing". The two
// are never interchangeable, which is the whole reason these helpers exist:
// half the query builders read `[]` as "no filter".

import { skipToken, type QueryFunction, type QueryKey, type SkipToken } from "@tanstack/react-query"

/** The project's services, or `undefined` when no project is selected. */
export type ProjectServices = ReadonlyArray<string> | undefined

/** The header project, resolved to its services, plus whether that is known yet. */
export interface ProjectScope {
	/** The header's project, or `undefined` for all projects. */
	readonly namespace: string | undefined
	/** `undefined` when no project is selected; else the project's services (possibly none). */
	readonly services: ProjectServices
	/**
	 * True while a project is selected and its service list is not yet known.
	 * Every query that depends on the list stays disabled meanwhile (see
	 * {@link scopedQueryFn}), so a page never flashes another project's rows.
	 */
	readonly isPending: boolean
	readonly error: Error | null
}

/**
 * The services a page should query: the project's, narrowed by the page's own
 * service filter.
 *
 * An intersection, so a sidebar service outside the project yields an empty
 * list (nothing) rather than quietly widening the page to that service — the
 * header says which project the page is about, and the sidebar can only
 * narrow within it.
 */
export function scopeServices(
	project: ProjectServices,
	selected: string | ReadonlyArray<string> | undefined,
): ProjectServices {
	const picked = typeof selected === "string" ? [selected] : selected?.length ? selected : undefined
	if (project === undefined) return picked
	if (picked === undefined) return project
	const inProject = new Set(project)
	return picked.filter((service) => inProject.has(service))
}

/**
 * True when the scope can only ever match nothing.
 *
 * The logs and errors builders read an empty service list as "no filter", so
 * their hooks answer an empty result themselves instead of handing `[]` to SQL
 * that would return every service.
 */
export function matchesNothing(services: ProjectServices): boolean {
	return services !== undefined && services.length === 0
}

/**
 * Facet options restricted to the project — for facet queries whose own
 * dimension drops the service filter (so picking one service does not
 * collapse the list), which would otherwise list every project's services.
 */
export function withinProject<T extends { readonly name: string }>(
	options: ReadonlyArray<T>,
	project: ProjectServices,
): ReadonlyArray<T> {
	if (project === undefined) return options
	const inProject = new Set(project)
	return options.filter((option) => inProject.has(option.name))
}

/**
 * A query function that only runs once the project scope is known: `skipToken`
 * while it is pending (or when the caller's own precondition fails).
 */
export function scopedQueryFn<T, K extends QueryKey = QueryKey, P = never>(
	scope: Pick<ProjectScope, "isPending">,
	fn: QueryFunction<T, K, P> | false | undefined,
): QueryFunction<T, K, P> | SkipToken {
	return scope.isPending || !fn ? skipToken : fn
}

/** The marker {@link projectKey} puts in a query key, read back by {@link scopedPlaceholder}. */
const PROJECT_KEY_PART = "project"

/**
 * The project's part of a dependent query's key: the namespace (so a
 * placeholder can tell whose data it would be showing) and the services the
 * query actually filters on.
 */
export function projectKey(scope: Pick<ProjectScope, "namespace" | "services">) {
	return { [PROJECT_KEY_PART]: scope.namespace ?? null, services: scope.services ?? null }
}

function keyProject(queryKey: QueryKey): string | null | undefined {
	for (const part of queryKey) {
		if (part !== null && typeof part === "object" && PROJECT_KEY_PART in part) {
			const value = (part as Record<string, unknown>)[PROJECT_KEY_PART]
			return typeof value === "string" ? value : null
		}
	}
	return undefined
}

/**
 * `keepPreviousData`, but never across projects: the previous data is kept only
 * when its query was keyed (via {@link projectKey}) under the current project.
 * Anything else — another project's rows, or every project's — would be
 * exactly the flash of foreign data the scope exists to prevent, so the view
 * shows its loading state instead until the scoped answer arrives.
 */
export function scopedPlaceholder(scope: Pick<ProjectScope, "namespace" | "isPending">) {
	const project = scope.namespace ?? null
	return <T>(previous: T | undefined, previousQuery?: { readonly queryKey: QueryKey }): T | undefined =>
		!scope.isPending && previousQuery && keyProject(previousQuery.queryKey) === project
			? previous
			: undefined
}

interface MapEdge {
	readonly sourceService: string
	readonly targetService: string
}

interface MapDbEdge {
	readonly sourceService: string
}

interface MapOverview {
	readonly serviceName: string
	/** `unknown` for untagged telemetry — the same label the header selector offers. */
	readonly environment: string
}

/**
 * The service map, narrowed client-side to the header's project and
 * environment.
 *
 * - Overviews are one row per (service, environment), so both filters apply to
 *   them exactly.
 * - An edge stays when **either** end is in the project: a project's calls out
 *   to a shared service (or in from one) are part of how it works, and dropping
 *   them would draw the project as an island. The far end then appears as a
 *   bare node, without stats unless it is itself in the project.
 * - Edges carry no environment (the span-join rollup has none), so the
 *   environment can only prune them by their ends: an edge is dropped when an
 *   end is a service that reported in the window but never in the selected
 *   environment. An end with no overview at all (an uninstrumented peer) does
 *   not veto. The call counts on surviving edges are still every
 *   environment's — there is nothing finer to read them from.
 * - A database edge belongs to its calling service, so it follows that service.
 */
export function scopeServiceMap<
	Data extends {
		readonly edges: ReadonlyArray<MapEdge>
		readonly dbEdges: ReadonlyArray<MapDbEdge>
		readonly overviews: ReadonlyArray<MapOverview>
	},
>(data: Data, scope: { readonly services: ProjectServices; readonly environment: string | undefined }): Data {
	const { services, environment } = scope
	if (services === undefined && environment === undefined) return data

	const inProject = services === undefined ? undefined : new Set(services)
	const projectOk = (service: string) => inProject === undefined || inProject.has(service)

	let envOk = (_service: string) => true
	if (environment !== undefined) {
		const reported = new Set(data.overviews.map((row) => row.serviceName))
		const inEnvironment = new Set(
			data.overviews.filter((row) => row.environment === environment).map((row) => row.serviceName),
		)
		envOk = (service) => !reported.has(service) || inEnvironment.has(service)
	}
	return {
		...data,
		overviews: data.overviews.filter(
			(row) =>
				projectOk(row.serviceName) && (environment === undefined || row.environment === environment),
		),
		edges: data.edges.filter(
			(edge) =>
				(projectOk(edge.sourceService) || projectOk(edge.targetService)) &&
				envOk(edge.sourceService) &&
				envOk(edge.targetService),
		),
		dbEdges: data.dbEdges.filter((edge) => projectOk(edge.sourceService) && envOk(edge.sourceService)),
	}
}

/** The scope of a view with no project selected — for callers outside the header's reach. */
export const ALL_PROJECTS_SCOPE: ProjectScope = {
	namespace: undefined,
	services: undefined,
	isPending: false,
	error: null,
}
