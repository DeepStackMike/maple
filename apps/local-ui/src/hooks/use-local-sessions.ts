import { useInfiniteQuery, useQuery, type QueryKey } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import type { SessionReplaysListOutput } from "@maple/query-engine/ch"
import type { FilterOption } from "@maple/ui/components/filters/filter-section"
import { boundsKey, executeLocalCompiledQuery, localParams, noCursor } from "@/lib/query"
import { projectKey, scopedPlaceholder, scopedQueryFn, type ProjectScope } from "../lib/project-scope"
import { sessionTagsOf, type SessionTag } from "../lib/session-tags"
import type { TimeBounds } from "../lib/time"

const PAGE_SIZE = 50

interface SessionCursor {
	startTime: string
	sessionId: string
}

export interface SessionFilters {
	service?: string
	/**
	 * Exact `deployment.environment.name` (or the deprecated
	 * `deployment.environment`) out of the session's resource attributes.
	 *
	 * Supplied by the header selector rather than by a sidebar facet: the
	 * sessions list has no environment section, because the environment is a
	 * statement about which deployment the whole session is about rather than
	 * one of the dimensions this list slices by.
	 */
	env?: string
	browser?: string
	device?: string
	/** ISO 3166-1 alpha-2, as the `Country` column stores it. */
	country?: string
	/** Only sessions with at least one recorded error. */
	errorsOnly?: boolean
	/** Substring match on the initial page URL. */
	search?: string
	/** Exact page path visited anywhere in the session, not just where it landed. */
	pagePath?: string
	/** Only sessions carrying every one of these tags (see `lib/session-tags.ts`). */
	tags?: ReadonlyArray<SessionTag>
}

/** A list row plus its rule-based tags, derived once here rather than per render. */
export interface SessionListRow extends SessionReplaysListOutput {
	readonly tags: ReadonlyArray<SessionTag>
}

const tagsOrUndefined = (tags: ReadonlyArray<SessionTag> | undefined) =>
	tags && tags.length > 0 ? tags : undefined

/**
 * Infinite list of browser sessions, newest first (keyset on StartTime).
 *
 * `project` is the header project as its services. The builder ANDs it with
 * the sidebar's `serviceName`, so a sidebar service outside the project lists
 * nothing, and an empty project matches nothing in SQL.
 */
export function useLocalSessions(filters: SessionFilters, bounds: TimeBounds, project: ProjectScope) {
	return useInfiniteQuery({
		queryKey: ["local", "sessions", filters, projectKey(project), boundsKey(bounds)],
		initialPageParam: noCursor<SessionCursor>(),
		placeholderData: scopedPlaceholder(project),
		queryFn: scopedQueryFn<ReadonlyArray<SessionListRow>, QueryKey, SessionCursor | undefined>(
			project,
			async ({ pageParam, signal }) => {
				const compiled = CH.compile(
					CH.sessionReplaysListQuery({
						limit: PAGE_SIZE,
						cursor: pageParam,
						serviceName: filters.service,
						services: project.services,
						browser: filters.browser,
						deviceType: filters.device,
						country: filters.country,
						environment: filters.env,
						hasErrors: filters.errorsOnly,
						search: filters.search,
						pagePath: filters.pagePath,
						tags: tagsOrUndefined(filters.tags),
					}),
					localParams(bounds),
				)
				const rows = await executeLocalCompiledQuery(compiled, signal)
				return rows.map((row): SessionListRow => ({ ...row, tags: sessionTagsOf(row) }))
			},
		),
		// (StartTime, SessionId), not StartTime alone: the SDK stamps start times
		// from a JS `Date`, so they are only millisecond-resolution and two
		// sessions sharing one is ordinary. A page boundary landing inside such a
		// tie would drop every session on the far side of it.
		getNextPageParam: (lastPage) => {
			const last = lastPage.length === PAGE_SIZE ? lastPage[lastPage.length - 1] : undefined
			return last ? { startTime: last.startTime, sessionId: last.sessionId } : undefined
		},
	})
}

export interface SessionFacets {
	readonly service: ReadonlyArray<FilterOption>
	readonly browser: ReadonlyArray<FilterOption>
	readonly device: ReadonlyArray<FilterOption>
	/** Option names are ISO country codes — labelled for display, filtered by code. */
	readonly country: ReadonlyArray<FilterOption>
	/** Page paths visited anywhere in a session, by sessions that reached them (top 200). */
	readonly page: ReadonlyArray<FilterOption>
	/** Sessions per tag, each counted under the other selected tags; absent tags have none. */
	readonly tag: ReadonlyArray<FilterOption>
	/** Distinct sessions with at least one error, for the toggle count. */
	readonly errorCount: number
	/** Sessions in the window under every active filter, not just the loaded pages. */
	readonly total: number | undefined
	/** Sessions with activity in the live window before the window's end. */
	readonly live: number | undefined
}

const EMPTY_FACETS: SessionFacets = {
	service: [],
	browser: [],
	device: [],
	country: [],
	page: [],
	tag: [],
	errorCount: 0,
	total: undefined,
	live: undefined,
}

/**
 * Facet counts for the sessions filter bar. Each dimension excludes its own
 * active filter so selecting it doesn't collapse the option list (handled in
 * the DSL query).
 */
export function useLocalSessionFacets(filters: SessionFilters, bounds: TimeBounds, project: ProjectScope) {
	const placeholder = scopedPlaceholder(project)
	return useQuery<SessionFacets>({
		queryKey: ["local", "session-facets", filters, projectKey(project), boundsKey(bounds)],
		staleTime: 30_000,
		queryFn: scopedQueryFn(project, async ({ signal }) => {
			const compiled = CH.compileUnion(
				CH.sessionReplaysFacetsQuery({
					serviceName: filters.service,
					// A page-wide scope, so it narrows every branch — the service
					// facet then lists only the project's services.
					services: project.services,
					browser: filters.browser,
					deviceType: filters.device,
					country: filters.country,
					environment: filters.env,
					hasErrors: filters.errorsOnly,
					search: filters.search,
					pagePath: filters.pagePath,
					tags: tagsOrUndefined(filters.tags),
				}),
				localParams(bounds),
			)
			const rows = await executeLocalCompiledQuery(compiled, signal)

			const count = (facetType: string): number | undefined => {
				const row = rows.find((candidate) => candidate.facetType === facetType)
				return row === undefined ? undefined : Number(row.count)
			}

			const pick = (facetType: string): ReadonlyArray<FilterOption> =>
				rows
					.filter((row) => row.facetType === facetType && row.name)
					.map((row) => ({ name: row.name, count: row.count }))

			return {
				service: pick("service"),
				browser: pick("browser"),
				device: pick("device"),
				country: pick("country"),
				page: pick("page"),
				tag: pick("tag"),
				errorCount: count("error") ?? 0,
				total: count("total"),
				live: count("live"),
			}
		}),
		// Empty facets rather than none, so the sidebar keeps its sections — but
		// never another project's counts (see `scopedPlaceholder`).
		placeholderData: (previous, previousQuery) => placeholder(previous, previousQuery) ?? EMPTY_FACETS,
	})
}
