import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { Option } from "effect"
import { boundsKey, executeLocalCompiledFirstRow, executeLocalCompiledQuery, localParams } from "@/lib/query"
import type { TimeBounds } from "../lib/time"
import { groupSparkPoints, type SparkPoint } from "../lib/error-spark"
import type { ErrorSlice, VersionTraffic } from "../lib/error-versions"

export interface ErrorsFilters {
	/** Exact service name match. */
	service?: string
	/** Exact `deployment.environment` resource attribute (`unknown` matches untagged rows). */
	env?: string
	/** Exact `ErrorLabel` match — the value the "Error Type" facet lists. */
	errorType?: string
	/** Exact `service.version` match — the value the "Version" facet lists. */
	version?: string
	/** Restrict to root-span errors. */
	rootOnly?: boolean
}

function sharedFilters(filters: ErrorsFilters) {
	return {
		services: filters.service ? [filters.service] : undefined,
		deploymentEnvs: filters.env ? [filters.env] : undefined,
		errorLabels: filters.errorType ? [filters.errorType] : undefined,
		serviceVersions: filters.version ? [filters.version] : undefined,
	}
}

/** Headline stats for the errors view (error_events × service_usage). */
export function useLocalErrorsSummary(filters: ErrorsFilters, bounds: TimeBounds) {
	return useQuery({
		queryKey: ["local", "errors", "summary", filters, boundsKey(bounds)],
		placeholderData: keepPreviousData,
		queryFn: async ({ signal }): Promise<CH.ErrorsSummaryOutput | null> => {
			const row = await executeLocalCompiledFirstRow(
				CH.compile(
					CH.errorsSummaryQuery({ ...sharedFilters(filters), rootOnly: filters.rootOnly }),
					localParams(bounds),
				),
				signal,
			)
			return Option.getOrNull(row)
		},
	})
}

/** A fingerprint-grouped error type; `serviceNames` names up to three of its services. */
export type ErrorTypeRow = CH.ErrorsByTypeOutput

/** Fingerprint-grouped error types, most frequent first. */
export function useLocalErrorsByType(filters: ErrorsFilters, bounds: TimeBounds) {
	return useQuery({
		queryKey: ["local", "errors", "by-type", filters, boundsKey(bounds)],
		placeholderData: keepPreviousData,
		queryFn: ({ signal }): Promise<ReadonlyArray<ErrorTypeRow>> =>
			executeLocalCompiledQuery(
				CH.compile(
					CH.errorsByTypeQuery({
						...sharedFilters(filters),
						rootOnly: filters.rootOnly,
						limit: 50,
					}),
					localParams(bounds),
				),
				signal,
			),
	})
}

/**
 * The filters a per-version breakdown runs under: every one but the Version
 * facet. Versions are the thing being compared, so filtering to one would leave
 * its predecessor with nothing and every error would read as new.
 */
function versionFilters(filters: ErrorsFilters) {
	return { ...sharedFilters(filters), serviceVersions: undefined, rootOnly: filters.rootOnly }
}

/** Keyed by hash list, not row objects: counts change on every refetch. */
const hashesKey = (fingerprintHashes: ReadonlyArray<string>) => [...fingerprintHashes].sort().join(",")

function groupByFingerprint<T extends { readonly fingerprintHash: string }>(
	rows: ReadonlyArray<T>,
	into = new Map<string, Array<T>>(),
): Map<string, Array<T>> {
	for (const row of rows) {
		const list = into.get(row.fingerprintHash)
		if (list) list.push(row)
		else into.set(row.fingerprintHash, [row])
	}
	return into
}

/**
 * Per-build occurrence split for every fingerprint on the page, in one query,
 * across all services and environments merged. The Compare-versions table uses
 * it for the count no (service, environment) slice accounts for, so the table
 * always adds up to the row's count.
 */
export function useLocalErrorVersions(
	fingerprintHashes: ReadonlyArray<string>,
	filters: ErrorsFilters,
	bounds: TimeBounds,
) {
	return useQuery({
		queryKey: ["local", "errors", "versions", hashesKey(fingerprintHashes), filters, boundsKey(bounds)],
		placeholderData: keepPreviousData,
		queryFn:
			fingerprintHashes.length > 0
				? async ({ signal }): Promise<Map<string, Array<CH.ErrorVersionsOutput>>> =>
						groupByFingerprint(
							await executeLocalCompiledQuery(
								CH.compile(
									CH.errorVersionsQuery({ ...versionFilters(filters), fingerprintHashes }),
									localParams(bounds),
								),
								signal,
							),
						)
				: skipToken,
	})
}

/**
 * Every `service.version` per (service, environment) in the window, with its
 * span count and first/last span — what orders versions into predecessors and
 * supplies each side's denominator. Narrowed client-side to the page's service
 * and environment filters; the environment is labelled the way the errors
 * queries label it (`''` reads `unknown`).
 */
export function useLocalVersionTraffic(filters: ErrorsFilters, bounds: TimeBounds) {
	return useQuery({
		queryKey: ["local", "errors", "version-traffic", filters.service, filters.env, boundsKey(bounds)],
		placeholderData: keepPreviousData,
		queryFn: async ({ signal }): Promise<Array<VersionTraffic>> => {
			const rows = await executeLocalCompiledQuery(
				CH.compile(
					CH.serviceCatalogVersionsQuery({ serviceName: filters.service }),
					localParams(bounds),
				),
				signal,
			)
			return rows
				.map((row) => ({
					serviceName: row.serviceName,
					environment: row.environment || UNKNOWN_ENVIRONMENT,
					version: row.version,
					spanCount: Number(row.spanCount),
					firstSeen: row.firstSeen,
					lastSeen: row.lastSeen,
				}))
				.filter((row) => !filters.env || row.environment === filters.env)
		},
	})
}

/** The errors queries' label for an untagged environment (see query-engine `envLabel`). */
const UNKNOWN_ENVIRONMENT = "unknown"

/**
 * Each fingerprint's count per version, split by (service, environment), in
 * one query batched over the whole page's fingerprints. The environment is
 * already `envLabel`'d, so an untagged row reads `unknown`, matching
 * {@link useLocalVersionTraffic}.
 */
export function useLocalErrorSlices(
	fingerprintHashes: ReadonlyArray<string>,
	filters: ErrorsFilters,
	bounds: TimeBounds,
) {
	return useQuery({
		queryKey: [
			"local",
			"errors",
			"version-slices",
			hashesKey(fingerprintHashes),
			filters,
			boundsKey(bounds),
		],
		placeholderData: keepPreviousData,
		queryFn:
			fingerprintHashes.length > 0
				? async ({ signal }): Promise<Map<string, Array<ErrorSlice>>> =>
						groupByFingerprint(
							await executeLocalCompiledQuery(
								CH.compile(
									CH.errorVersionSlicesQuery({
										...versionFilters(filters),
										fingerprintHashes,
									}),
									localParams(bounds),
								),
								signal,
							),
						)
				: skipToken,
	})
}

/**
 * Bucketed occurrence counts for every fingerprint on the page, in one scan.
 *
 * The compile window is the page's (padded) bounds so a clock-skewed
 * exporter's rows are not filtered out, while `sparkWindow` decides what is
 * *drawn* and how wide a bucket is (`bucketSeconds`). See `error-spark.ts`.
 */
export function useLocalErrorsSpark(
	fingerprintHashes: ReadonlyArray<string>,
	filters: ErrorsFilters,
	bounds: TimeBounds,
	bucketSeconds: number,
) {
	return useQuery({
		queryKey: [
			"local",
			"errors",
			"spark",
			hashesKey(fingerprintHashes),
			filters,
			boundsKey(bounds),
			bucketSeconds,
		],
		placeholderData: keepPreviousData,
		queryFn:
			fingerprintHashes.length > 0
				? async ({ signal }): Promise<Map<string, Array<SparkPoint>>> => {
						const rows = await executeLocalCompiledQuery(
							CH.compile(
								CH.errorsSparkQuery({
									...sharedFilters(filters),
									rootOnly: filters.rootOnly,
									fingerprintHashes,
								}),
								{ ...localParams(bounds), bucketSeconds },
							),
							signal,
						)
						return groupSparkPoints(rows)
					}
				: skipToken,
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
 * Sidebar facets. Each section counts under the other filters but not its own
 * (the query drops a dimension's own filter from its branch).
 */
export function useLocalErrorsFacets(filters: ErrorsFilters, bounds: TimeBounds) {
	return useQuery({
		queryKey: ["local", "errors", "facets", filters, boundsKey(bounds)],
		placeholderData: keepPreviousData,
		queryFn: async ({ signal }): Promise<ErrorsFacets> => {
			const rows = await executeLocalCompiledQuery(
				CH.compileUnion(
					CH.errorsFacetsQuery({ ...sharedFilters(filters), rootOnly: filters.rootOnly }),
					localParams(bounds),
				),
				signal,
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
 * Its own query rather than more columns on `errorsByTypeQuery`: a stacktrace
 * is kilobytes and only the row the user opened ever shows one. Unfiltered by
 * service on purpose — once a row is open the question is what the newest one
 * looked like.
 */
export function useLocalErrorSampleStack(fingerprintHash: string | undefined, bounds: TimeBounds) {
	return useQuery({
		queryKey: ["local", "errors", "sample-stack", fingerprintHash, boundsKey(bounds)],
		queryFn: fingerprintHash
			? async ({ signal }): Promise<CH.ErrorSampleStackOutput | null> => {
					const row = await executeLocalCompiledFirstRow(
						CH.compile(CH.errorSampleStackQuery({ fingerprintHash }), localParams(bounds)),
						signal,
					)
					return Option.getOrNull(row)
				}
			: skipToken,
	})
}

/** Most recently errored traces for one fingerprint (expanded row), under the view's filters. */
export function useLocalErrorTraces(
	fingerprintHash: string | undefined,
	filters: ErrorsFilters,
	bounds: TimeBounds,
) {
	return useQuery({
		queryKey: [
			"local",
			"errors",
			"traces",
			fingerprintHash,
			filters.rootOnly,
			filters.service,
			filters.env,
			filters.errorType,
			filters.version,
			boundsKey(bounds),
		],
		queryFn: fingerprintHash
			? ({ signal }): Promise<ReadonlyArray<CH.ErrorDetailTracesOutput>> =>
					executeLocalCompiledQuery(
						CH.compile(
							CH.errorDetailTracesQuery({
								fingerprintHash,
								rootOnly: filters.rootOnly,
								...sharedFilters(filters),
								limit: 10,
							}),
							localParams(bounds),
						),
						signal,
					)
			: skipToken,
	})
}

/**
 * Browser sessions this error was hit in (expanded row).
 *
 * `messageMatch` comes from the fingerprint's own latest occurrence, so the
 * caller mounts this only once {@link useLocalErrorSampleStack} has resolved:
 * passing `undefined` drops the branch of the query that finds browser-side
 * errors at all. Unfiltered by service, like the stack.
 */
export function useLocalErrorSessions(
	fingerprintHash: string | undefined,
	messageMatch: string | undefined,
	bounds: TimeBounds,
) {
	return useQuery({
		queryKey: ["local", "errors", "sessions", fingerprintHash, messageMatch, boundsKey(bounds)],
		queryFn: fingerprintHash
			? ({ signal }): Promise<ReadonlyArray<CH.ErrorSessionsOutput>> =>
					executeLocalCompiledQuery(
						CH.compile(
							CH.errorSessionsQuery({ fingerprintHash, messageMatch, limit: 10 }),
							localParams(bounds),
						),
						signal,
					)
			: skipToken,
	})
}
