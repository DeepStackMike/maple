import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { Option } from "effect"
import { executeLocalCompiledFirstRow, executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { boundsForRange } from "../lib/time"

export interface ErrorsFilters {
	/** Exact service name match. */
	service?: string
	/** Exact `deployment.environment` resource attribute. */
	env?: string
	/** Exact `ErrorLabel` match — the value the "Error Type" facet lists. */
	errorType?: string
	/** Exact `service.version` match — the value the "Version" facet lists. */
	version?: string
	/**
	 * Restrict to root-span errors — the *unchecked* state of the sidebar's
	 * "All span errors" box, which is how `apps/web` spelled the same filter.
	 */
	rootOnly?: boolean
	/** Time-range preset key (see `TIME_RANGES`). */
	range?: string
}

function commonOpts(filters: ErrorsFilters) {
	return {
		rootOnly: filters.rootOnly,
		services: filters.service ? [filters.service] : undefined,
		deploymentEnvs: filters.env ? [filters.env] : undefined,
		errorLabels: filters.errorType ? [filters.errorType] : undefined,
		serviceVersions: filters.version ? [filters.version] : undefined,
	}
}

/** Headline stats for the errors view (error_events × service_usage). */
export function useLocalErrorsSummary(filters: ErrorsFilters) {
	return useQuery({
		queryKey: ["local", "errors", "summary", filters],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<CH.ErrorsSummaryOutput | null> => {
			const { startTime, endTime } = boundsForRange(filters.range)
			const row = await executeLocalCompiledFirstRow(
				CH.compile(CH.errorsSummaryQuery(commonOpts(filters)), {
					orgId: LOCAL_ORG_ID,
					startTime,
					endTime,
				}),
			)
			return Option.getOrNull(row)
		},
	})
}

/** Fingerprint-grouped error types, most frequent first. */
export function useLocalErrorsByType(filters: ErrorsFilters) {
	return useQuery({
		queryKey: ["local", "errors", "by-type", filters],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<CH.ErrorsByTypeOutput>> => {
			const { startTime, endTime } = boundsForRange(filters.range)
			return executeLocalCompiledQuery(
				CH.compile(CH.errorsByTypeQuery({ ...commonOpts(filters), limit: 50 }), {
					orgId: LOCAL_ORG_ID,
					startTime,
					endTime,
				}),
			)
		},
	})
}

/**
 * Per-build occurrence split for every fingerprint on the page, in one query.
 *
 * One request for the whole list, not one per row: the list shows fifty
 * fingerprints and every one of them wants the version it was introduced in, and
 * chDB runs local queries serially — fifty round trips would be the page's whole
 * latency budget spent on a subtitle.
 *
 * Returned as a Map so a row looks its own versions up by hash instead of
 * re-filtering the flat result on every render. Rows come back oldest-first
 * within a fingerprint, which is the order "introduced in" reads off; the
 * Compare-versions table re-sorts by recency for display.
 */
export function useLocalErrorVersions(fingerprintHashes: ReadonlyArray<string>, filters: ErrorsFilters) {
	// The key is the hash list, not the row objects: counts change on every
	// refetch and would evict a cache entry whose answer did not move.
	const key = [...fingerprintHashes].sort().join(",")
	return useQuery({
		queryKey: ["local", "errors", "versions", key, filters],
		enabled: fingerprintHashes.length > 0,
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<Map<string, Array<CH.ErrorVersionsOutput>>> => {
			const { startTime, endTime } = boundsForRange(filters.range)
			const rows = await executeLocalCompiledQuery(
				CH.compile(CH.errorVersionsQuery({ ...commonOpts(filters), fingerprintHashes }), {
					orgId: LOCAL_ORG_ID,
					startTime,
					endTime,
				}),
			)
			const byFingerprint = new Map<string, Array<CH.ErrorVersionsOutput>>()
			for (const row of rows) {
				const list = byFingerprint.get(row.fingerprintHash)
				if (list) list.push(row)
				else byFingerprint.set(row.fingerprintHash, [row])
			}
			return byFingerprint
		},
	})
}

export interface FacetOption {
	name: string
	count: number
}

export interface ErrorsFacets {
	services: Array<FacetOption>
	environments: Array<FacetOption>
	errorTypes: Array<FacetOption>
	versions: Array<FacetOption>
}

/**
 * Sidebar facet counts (one UNION query, one scan).
 *
 * Every active filter goes in, not just the range: `errorsFacetsQuery` drops
 * each section's own dimension server-side (its `except` argument), so ticking
 * `production` narrows the Service counts while Environment still lists its
 * alternatives. Passing only `rootOnly` — which is what this hook did — left
 * every number on the sidebar describing the unfiltered window, so the counts
 * never moved when a box was ticked and none of them matched the list beside
 * them.
 */
export function useLocalErrorsFacets(filters: ErrorsFilters) {
	return useQuery({
		queryKey: ["local", "errors", "facets", filters],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ErrorsFacets> => {
			const { startTime, endTime } = boundsForRange(filters.range)
			const rows = await executeLocalCompiledQuery(
				CH.compileUnion(CH.errorsFacetsQuery(commonOpts(filters)), {
					orgId: LOCAL_ORG_ID,
					startTime,
					endTime,
				}),
			)
			const pick = (facetType: string) =>
				rows
					.filter((r) => r.facetType === facetType)
					.map((r) => ({ name: r.name, count: Number(r.count) }))
			return {
				services: pick("service"),
				environments: pick("environment"),
				errorTypes: pick("error_type"),
				versions: pick("version"),
			}
		},
	})
}

/**
 * The latest occurrence's exception columns for one fingerprint (expanded row).
 *
 * Its own query rather than four more columns on `errorsByTypeQuery`: a
 * stacktrace is kilobytes, the list is fifty rows, and only the row the user
 * opened ever shows one. Unfiltered by service on purpose — the list row's
 * service filter narrows *which* errors are listed, and once one is open the
 * question is what the newest one looked like.
 */
export function useLocalErrorSampleStack(fingerprintHash: string | undefined, filters: ErrorsFilters) {
	return useQuery({
		queryKey: ["local", "errors", "sample-stack", fingerprintHash, filters.range],
		enabled: !!fingerprintHash,
		queryFn: async (): Promise<CH.ErrorSampleStackOutput | null> => {
			const { startTime, endTime } = boundsForRange(filters.range)
			const row = await executeLocalCompiledFirstRow(
				CH.compile(CH.errorSampleStackQuery({ fingerprintHash: fingerprintHash! }), {
					orgId: LOCAL_ORG_ID,
					startTime,
					endTime,
				}),
			)
			return Option.getOrNull(row)
		},
	})
}

/** Most recently errored traces for one fingerprint (expanded row). */
export function useLocalErrorTraces(fingerprintHash: string | undefined, filters: ErrorsFilters) {
	return useQuery({
		queryKey: ["local", "errors", "traces", fingerprintHash, filters],
		enabled: !!fingerprintHash,
		queryFn: async (): Promise<ReadonlyArray<CH.ErrorDetailTracesOutput>> => {
			const { startTime, endTime } = boundsForRange(filters.range)
			return executeLocalCompiledQuery(
				CH.compile(
					CH.errorDetailTracesQuery({
						fingerprintHash: fingerprintHash!,
						rootOnly: filters.rootOnly,
						services: filters.service ? [filters.service] : undefined,
						limit: 10,
					}),
					{ orgId: LOCAL_ORG_ID, startTime, endTime },
				),
			)
		},
	})
}
