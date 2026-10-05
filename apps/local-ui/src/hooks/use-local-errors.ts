import { skipToken, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { Option } from "effect"
import { boundsKey, executeLocalCompiledFirstRow, executeLocalCompiledQuery, localParams } from "@/lib/query"
import type { TimeBounds } from "../lib/time"
import { groupSparkPoints, type SparkPoint } from "../lib/error-spark"
import type { ErrorSlice, VersionTraffic } from "../lib/error-versions"
import {
	matchesNothing,
	projectKey,
	scopedPlaceholder,
	scopedQueryFn,
	scopeServices,
	withinProject,
	type ProjectScope,
	type ProjectServices,
} from "../lib/project-scope"

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

/**
 * The filters every errors builder shares. `project` is the header project as
 * its services, intersected with the sidebar service; when that leaves nothing
 * the hooks answer empty without SQL, because these builders read `[]` as no
 * filter (see `matchesNothing`).
 */
function sharedFilters(filters: ErrorsFilters, project: ProjectServices) {
	return {
		services: scopeServices(project, filters.service),
		deploymentEnvs: filters.env ? [filters.env] : undefined,
		errorLabels: filters.errorType ? [filters.errorType] : undefined,
		serviceVersions: filters.version ? [filters.version] : undefined,
	}
}

/** Headline stats for the errors view (error_events × service_usage). */
export function useLocalErrorsSummary(filters: ErrorsFilters, bounds: TimeBounds, scope: ProjectScope) {
	return useQuery({
		queryKey: ["local", "errors", "summary", filters, projectKey(scope), boundsKey(bounds)],
		placeholderData: scopedPlaceholder(scope),
		queryFn: scopedQueryFn(scope, async ({ signal }): Promise<CH.ErrorsSummaryOutput | null> => {
			const shared = sharedFilters(filters, scope.services)
			if (matchesNothing(shared.services)) return null
			const row = await executeLocalCompiledFirstRow(
				CH.compile(
					CH.errorsSummaryQuery({ ...shared, rootOnly: filters.rootOnly }),
					localParams(bounds),
				),
				signal,
			)
			return Option.getOrNull(row)
		}),
	})
}

/** A fingerprint-grouped error type; `serviceNames` names up to three of its services. */
export type ErrorTypeRow = CH.ErrorsByTypeOutput

/** Fingerprint-grouped error types, most frequent first. */
export function useLocalErrorsByType(filters: ErrorsFilters, bounds: TimeBounds, scope: ProjectScope) {
	return useQuery({
		queryKey: ["local", "errors", "by-type", filters, projectKey(scope), boundsKey(bounds)],
		placeholderData: scopedPlaceholder(scope),
		queryFn: scopedQueryFn(scope, async ({ signal }): Promise<ReadonlyArray<ErrorTypeRow>> => {
			const shared = sharedFilters(filters, scope.services)
			if (matchesNothing(shared.services)) return []
			return executeLocalCompiledQuery(
				CH.compile(
					CH.errorsByTypeQuery({ ...shared, rootOnly: filters.rootOnly, limit: 50 }),
					localParams(bounds),
				),
				signal,
			)
		}),
	})
}

/**
 * The filters a per-version breakdown runs under: every one but the Version
 * facet. Versions are the thing being compared, so filtering to one would leave
 * its predecessor with nothing and every error would read as new.
 */
function versionFilters(filters: ErrorsFilters, project: ProjectServices) {
	return { ...sharedFilters(filters, project), serviceVersions: undefined, rootOnly: filters.rootOnly }
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
	scope: ProjectScope,
) {
	return useQuery({
		queryKey: [
			"local",
			"errors",
			"versions",
			hashesKey(fingerprintHashes),
			filters,
			projectKey(scope),
			boundsKey(bounds),
		],
		placeholderData: scopedPlaceholder(scope),
		queryFn: scopedQueryFn(
			scope,
			fingerprintHashes.length > 0 &&
				(async ({ signal }): Promise<Map<string, Array<CH.ErrorVersionsOutput>>> => {
					const shared = versionFilters(filters, scope.services)
					if (matchesNothing(shared.services)) return new Map()
					return groupByFingerprint(
						await executeLocalCompiledQuery(
							CH.compile(
								CH.errorVersionsQuery({ ...shared, fingerprintHashes }),
								localParams(bounds),
							),
							signal,
						),
					)
				}),
		),
	})
}

/**
 * Every `service.version` per (service, environment) in the window, with its
 * span count and first/last span — what orders versions into predecessors and
 * supplies each side's denominator. Narrowed client-side to the page's service
 * (within the header project) and environment filters; the environment is
 * labelled the way the errors queries label it (`''` reads `unknown`).
 */
export function useLocalVersionTraffic(filters: ErrorsFilters, bounds: TimeBounds, scope: ProjectScope) {
	return useQuery({
		queryKey: [
			"local",
			"errors",
			"version-traffic",
			filters.service,
			filters.env,
			projectKey(scope),
			boundsKey(bounds),
		],
		placeholderData: scopedPlaceholder(scope),
		queryFn: scopedQueryFn(scope, async ({ signal }): Promise<Array<VersionTraffic>> => {
			const services = scopeServices(scope.services, filters.service)
			if (matchesNothing(services)) return []
			const inScope = services === undefined ? undefined : new Set(services)
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
				.filter(
					(row) =>
						(!filters.env || row.environment === filters.env) &&
						(inScope === undefined || inScope.has(row.serviceName)),
				)
		}),
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
	scope: ProjectScope,
) {
	return useQuery({
		queryKey: [
			"local",
			"errors",
			"version-slices",
			hashesKey(fingerprintHashes),
			filters,
			projectKey(scope),
			boundsKey(bounds),
		],
		placeholderData: scopedPlaceholder(scope),
		queryFn: scopedQueryFn(
			scope,
			fingerprintHashes.length > 0 &&
				(async ({ signal }): Promise<Map<string, Array<ErrorSlice>>> => {
					const shared = versionFilters(filters, scope.services)
					if (matchesNothing(shared.services)) return new Map()
					return groupByFingerprint(
						await executeLocalCompiledQuery(
							CH.compile(
								CH.errorVersionSlicesQuery({ ...shared, fingerprintHashes }),
								localParams(bounds),
							),
							signal,
						),
					)
				}),
		),
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
	scope: ProjectScope,
) {
	return useQuery({
		queryKey: [
			"local",
			"errors",
			"spark",
			hashesKey(fingerprintHashes),
			filters,
			projectKey(scope),
			boundsKey(bounds),
			bucketSeconds,
		],
		placeholderData: scopedPlaceholder(scope),
		queryFn: scopedQueryFn(
			scope,
			fingerprintHashes.length > 0 &&
				(async ({ signal }): Promise<Map<string, Array<SparkPoint>>> => {
					const shared = sharedFilters(filters, scope.services)
					if (matchesNothing(shared.services)) return new Map()
					const rows = await executeLocalCompiledQuery(
						CH.compile(
							CH.errorsSparkQuery({ ...shared, rootOnly: filters.rootOnly, fingerprintHashes }),
							{ ...localParams(bounds), bucketSeconds },
						),
						signal,
					)
					return groupSparkPoints(rows)
				}),
		),
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

const EMPTY_ERRORS_FACETS: ErrorsFacets = { services: [], environments: [], errorTypes: [], versions: [] }

/**
 * Sidebar facets. Each section counts under the other filters but not its own
 * (the query drops a dimension's own filter from its branch).
 *
 * The header project is not one of those dimensions, so the Service section is
 * narrowed to it client-side: its branch drops the `services` filter along with
 * the sidebar's pick, and would otherwise offer every project's services. When
 * the sidebar's service is outside the project, every other section is empty
 * (the page is) and the Service section still lists the project's services, so
 * there is somewhere to click back to.
 */
export function useLocalErrorsFacets(filters: ErrorsFilters, bounds: TimeBounds, scope: ProjectScope) {
	return useQuery({
		queryKey: ["local", "errors", "facets", filters, projectKey(scope), boundsKey(bounds)],
		placeholderData: scopedPlaceholder(scope),
		queryFn: scopedQueryFn(scope, async ({ signal }): Promise<ErrorsFacets> => {
			const project = scope.services
			if (matchesNothing(project)) return EMPTY_ERRORS_FACETS
			const shared = sharedFilters(filters, project)
			const outside = matchesNothing(shared.services)
			const rows = await executeLocalCompiledQuery(
				CH.compileUnion(
					CH.errorsFacetsQuery({
						...shared,
						services: outside ? project : shared.services,
						rootOnly: filters.rootOnly,
					}),
					localParams(bounds),
				),
				signal,
			)
			const pick = (facetType: string) =>
				outside && facetType !== "service"
					? []
					: rows
							.filter((r) => r.facetType === facetType)
							.map((r) => ({ name: r.name, count: Number(r.count) }))
			return {
				services: [...withinProject(pick("service"), project)],
				environments: pick("environment"),
				errorTypes: pick("error_type"),
				versions: pick("version"),
			}
		}),
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
	scope: ProjectScope,
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
			projectKey(scope),
			boundsKey(bounds),
		],
		queryFn: scopedQueryFn(
			scope,
			fingerprintHash !== undefined &&
				(async ({ signal }): Promise<ReadonlyArray<CH.ErrorDetailTracesOutput>> => {
					const shared = sharedFilters(filters, scope.services)
					if (matchesNothing(shared.services)) return []
					return executeLocalCompiledQuery(
						CH.compile(
							CH.errorDetailTracesQuery({
								fingerprintHash,
								rootOnly: filters.rootOnly,
								...shared,
								limit: 10,
							}),
							localParams(bounds),
						),
						signal,
					)
				}),
		),
	})
}

/**
 * Browser sessions this error was hit in (expanded row).
 *
 * `messageMatch` comes from the fingerprint's own latest occurrence, so the
 * caller mounts this only once {@link useLocalErrorSampleStack} has resolved:
 * passing `undefined` drops the branch of the query that finds browser-side
 * errors at all. Unfiltered by service, like the stack.
 *
 * Scoped to the header project: the message branch would otherwise match the
 * same error text from another project's browser session.
 */
export function useLocalErrorSessions(
	fingerprintHash: string | undefined,
	messageMatch: string | undefined,
	bounds: TimeBounds,
	scope: ProjectScope,
) {
	return useQuery({
		queryKey: [
			"local",
			"errors",
			"sessions",
			fingerprintHash,
			messageMatch,
			projectKey(scope),
			boundsKey(bounds),
		],
		queryFn: scopedQueryFn(
			scope,
			fingerprintHash
				? ({ signal }): Promise<ReadonlyArray<CH.ErrorSessionsOutput>> =>
						executeLocalCompiledQuery(
							CH.compile(
								CH.errorSessionsQuery({
									fingerprintHash,
									messageMatch,
									services: scope.services,
									limit: 10,
								}),
								localParams(bounds),
							),
							signal,
						)
				: undefined,
		),
	})
}
