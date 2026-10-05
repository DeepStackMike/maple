import { useMemo } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { CH, coerceServiceOverviewRows } from "@maple/query-engine"
import { boundsKey, executeLocalCompiledQuery, localParams } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { resolveRangeWindow, toClickHouseDateTime, type TimeBounds } from "../lib/time"
import {
	baselineDelta,
	currentVersion,
	deriveServiceHealth,
	MIN_BASELINE_SPANS,
	rangeDurationSeconds,
	rangeWindowLabel,
	serviceRowKey,
	type LatencyBaselineSignal,
	type ServiceListRow,
	type ServiceVersionSighting,
} from "../lib/services-list"
import { bucketSecondsForRange } from "./use-local-metrics"

export interface ServiceCatalogFilters {
	/** Exact `deployment.environment` resource attribute. */
	env?: string
	/** Exact `service.namespace` resource attribute. */
	ns?: string
	/** Substring match on the service name (client-side). */
	search?: string
}

export interface ServiceCatalogEntry {
	serviceName: string
	serviceNamespaces: readonly string[]
	deploymentEnvironments: readonly string[]
	spanCount: number
	errorCount: number
	errorRate: number
	p50LatencyMs: number
	p95LatencyMs: number
	p99LatencyMs: number
	/** Log volume from the usage rollup (0 when the service has none). */
	logCount: number
}

export function toCatalogEntry(row: CH.ServiceCatalogOutput, logCount: number): ServiceCatalogEntry {
	const spanCount = Number(row.estimatedSpanCount) || Number(row.spanCount)
	const errorCount = Number(row.estimatedErrorCount) || Number(row.errorCount)
	return {
		serviceName: row.serviceName,
		serviceNamespaces: row.serviceNamespaces,
		deploymentEnvironments: row.deploymentEnvironments,
		spanCount,
		errorCount,
		errorRate: spanCount > 0 ? errorCount / spanCount : 0,
		p50LatencyMs: Number(row.p50LatencyMs),
		p95LatencyMs: Number(row.p95LatencyMs),
		p99LatencyMs: Number(row.p99LatencyMs),
		logCount,
	}
}

interface CatalogResult {
	entries: ReadonlyArray<ServiceCatalogEntry>
	totalIngestedBytes: number
}

function useCatalog(env: string | undefined, ns: string | undefined, bounds: TimeBounds) {
	return useQuery({
		queryKey: ["local", "services", "catalog", env ?? null, ns ?? null, boundsKey(bounds)],
		placeholderData: keepPreviousData,
		queryFn: async ({ signal }): Promise<CatalogResult> => {
			const params = localParams(bounds)
			const [catalogRows, usageRows] = await Promise.all([
				executeLocalCompiledQuery(
					CH.compile(
						CH.serviceCatalogQuery({
							deploymentEnvironment: env,
							serviceNamespace: ns,
							limit: 200,
						}),
						params,
					),
					signal,
				),
				executeLocalCompiledQuery(CH.compile(CH.serviceUsageQuery({}), params), signal),
			])
			const logsByService = new Map(
				usageRows.map((row) => [row.serviceName, Number(row.totalLogCount)]),
			)
			return {
				entries: catalogRows.map((row) =>
					toCatalogEntry(row, logsByService.get(row.serviceName) ?? 0),
				),
				// Every byte the usage rollup accounted for in the window, across all
				// signals and every service — including services with no entry-point
				// spans (a Maple that has only received logs or metrics). Home's
				// "nothing ingested yet" state reads this.
				totalIngestedBytes: usageRows.reduce((sum, row) => sum + Number(row.totalSizeBytes), 0),
			}
		},
	})
}

function countBy(
	entries: ReadonlyArray<ServiceCatalogEntry>,
	pick: (e: ServiceCatalogEntry) => readonly string[],
) {
	const counts = new Map<string, number>()
	for (const entry of entries) for (const name of pick(entry)) counts.set(name, (counts.get(name) ?? 0) + 1)
	return [...counts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/**
 * Name-level service catalog (Home, and anything asking "which services
 * exist"). Rows come from the env/ns-filtered query (its numbers are for that
 * slice); facets come from the unfiltered one, each counted under the other
 * facet only. With no filter both are one query.
 *
 * The Services page itself renders at the (service, environment) grain and
 * reads {@link useLocalServiceList} instead.
 */
export function useLocalServiceCatalog(filters: ServiceCatalogFilters, bounds: TimeBounds) {
	const { env, ns, search } = filters
	const filtered = useCatalog(env, ns, bounds)
	const unfiltered = useCatalog(undefined, undefined, bounds)

	const entries = useMemo(() => {
		const all = filtered.data?.entries ?? []
		const needle = search?.toLowerCase()
		return needle ? all.filter((e) => e.serviceName.toLowerCase().includes(needle)) : all
	}, [filtered.data, search])

	const facets = useMemo(() => {
		const all = unfiltered.data?.entries ?? []
		return {
			envFacets: countBy(
				ns ? all.filter((e) => e.serviceNamespaces.includes(ns)) : all,
				(e) => e.deploymentEnvironments,
			),
			nsFacets: countBy(
				env ? all.filter((e) => e.deploymentEnvironments.includes(env)) : all,
				(e) => e.serviceNamespaces,
			),
		}
	}, [unfiltered.data, env, ns])

	return {
		query: filtered,
		facetsFetching: unfiltered.isFetching,
		entries,
		...facets,
		totalErrorCount: entries.reduce((sum, e) => sum + e.errorCount, 0),
		totalIngestedBytes: filtered.data?.totalIngestedBytes ?? 0,
	}
}

// Services list — the (service, environment) grain the hosted page renders

export interface ServiceSparkPoint {
	readonly throughput: number
	readonly errorRate: number
}

export interface ServiceListData {
	/** One row per (service, environment), unfiltered — see {@link useLocalServiceList}. */
	readonly rows: ServiceListRow[]
	/** Rows whose previous window was too sparse to compare against, for the footer note. */
	readonly comparedCount: number
	/** Keyed by service name, matching the sparkline query's grain. */
	readonly series: ReadonlyMap<string, ServiceSparkPoint[]>
}

/**
 * Every row of the services list, at the grain the table draws.
 *
 * **Four queries, none of them per row.** The current window's metrics
 * (`serviceOverviewQuery`), the same aggregate over the window of equal length
 * immediately before it (`serviceHealthBaselineQuery`, which is that query
 * minus the commit dimension), one bucketed timeseries split by service for
 * every sparkline on the page, and one pass over `traces` for the versions. A
 * fleet of forty services costs four requests, the same as a fleet of one.
 *
 * **Unfiltered on purpose, and keyed only by the range.** Environment,
 * namespace, version, health and the name search are all applied in the browser
 * (`filterServiceRows`). Local mode's whole fleet is a few hundred rows, so
 * pushing a filter into SQL would buy nothing and cost two things worth more: a
 * refetch and a spinner on every checkbox, and facet counts computed over
 * already-filtered rows — which is how a sidebar ends up showing every
 * unselected environment at zero and stranding the choice that got you there.
 *
 * `useLocalServiceCatalog` above is unchanged and still name-level: Home and the
 * service map ask "which services exist", which is a different question from
 * "what is each deployment of each service doing", and answering it does not
 * need these four queries.
 */
export function useLocalServiceList(
	range: string | undefined,
	timeWindow: { readonly bounds: TimeBounds; readonly anchorMs: number },
) {
	const { bounds, anchorMs } = timeWindow
	return useQuery({
		queryKey: ["local", "services", "list", range ?? null, boundsKey(bounds)],
		placeholderData: keepPreviousData,
		queryFn: async ({ signal }): Promise<ServiceListData> => {
			// One anchor for all four windows — the page's, so the previous window
			// abuts the current one exactly and only moves on refresh.
			const resolved = resolveRangeWindow(range, anchorMs)
			const windowSeconds = rangeDurationSeconds(range)
			const params = localParams(bounds)
			// The window of the same length ending where this one begins. Not a
			// fixed 7d baseline like the hosted page's: on a store holding an
			// afternoon there is no trailing week to compare against, and a delta
			// against a window that is mostly empty is worse than no delta.
			// Anchored to where the current window *starts*, not to now, so a custom
			// window is compared against the window before it rather than against
			// the one before this moment.
			const previousParams = {
				orgId: LOCAL_ORG_ID,
				startTime: toClickHouseDateTime(resolved.startMs - windowSeconds * 1000),
				endTime: toClickHouseDateTime(resolved.startMs),
			}
			const bucketSeconds = bucketSecondsForRange(range)

			const [overviewRows, previousRows, seriesRows, versionRows] = await Promise.all([
				executeLocalCompiledQuery(CH.compile(CH.serviceOverviewQuery({}), params), signal),
				executeLocalCompiledQuery(
					CH.compile(CH.serviceHealthBaselineQuery({}), previousParams),
					signal,
				),
				executeLocalCompiledQuery(
					CH.compile(
						CH.tracesTimeseriesQuery({
							metric: "count",
							allMetrics: true,
							needsSampling: true,
							// The entry-point population `serviceOverviewQuery` measures,
							// so a row's sparkline and its headline number describe the
							// same spans.
							rootOnly: true,
							bucketSeconds,
							groupBy: ["service"],
						}),
						{ ...params, bucketSeconds },
					),
					signal,
				),
				executeLocalCompiledQuery(CH.compile(CH.serviceCatalogVersionsQuery({}), params), signal),
			])

			// Namespace variants are merged rather than keyed on: the current
			// window's row already carries only its DOMINANT namespace (argMax in
			// `serviceOverviewQuery`), so keying the previous window by namespace
			// too would silently drop the baseline for any service whose dominant
			// namespace changed between the two windows. Spans add; the p95 comes
			// from whichever namespace carried the most of them.
			const previous = new Map<string, LatencyBaselineSignal & { dominantSpans: number }>()
			for (const row of previousRows) {
				const key = serviceRowKey(row.serviceName, row.environment)
				const spanCount = Number(row.baselineSpanCount)
				const existing = previous.get(key)
				if (existing === undefined) {
					previous.set(key, {
						p95LatencyMs: Number(row.baselineP95LatencyMs),
						spanCount,
						dominantSpans: spanCount,
					})
				} else {
					previous.set(key, {
						p95LatencyMs:
							spanCount > existing.dominantSpans
								? Number(row.baselineP95LatencyMs)
								: existing.p95LatencyMs,
						spanCount: existing.spanCount + spanCount,
						dominantSpans: Math.max(existing.dominantSpans, spanCount),
					})
				}
			}

			const series = new Map<string, ServiceSparkPoint[]>()
			for (const row of seriesRows) {
				const points = series.get(row.groupName)
				const point = { throughput: Number(row.count), errorRate: Number(row.errorRate) }
				if (points) points.push(point)
				else series.set(row.groupName, [point])
			}

			const versions = new Map<string, ServiceVersionSighting[]>()
			for (const row of versionRows) {
				const key = serviceRowKey(row.serviceName, row.environment)
				const sighting: ServiceVersionSighting = {
					version: row.version,
					firstSeen: row.firstSeen,
					lastSeen: row.lastSeen,
					spanCount: Number(row.spanCount),
				}
				const existing = versions.get(key)
				if (existing) existing.push(sighting)
				else versions.set(key, [sighting])
			}

			const windowLabel = rangeWindowLabel(range)
			let comparedCount = 0

			const rows = coerceServiceOverviewRows(overviewRows, windowSeconds).map((row): ServiceListRow => {
				const key = serviceRowKey(row.serviceName, row.environment)
				const baseline = previous.get(key)
				const usable =
					baseline !== undefined && baseline.spanCount >= MIN_BASELINE_SPANS ? baseline : undefined
				if (usable !== undefined) comparedCount += 1
				// The dominant commit, which `serviceOverviewQuery` already sorted to
				// the front of the array.
				const commitSha = row.commits.find(
					(commit) => commit.commitSha !== "" && commit.commitSha !== "N/A",
				)?.commitSha
				const version = currentVersion(versions.get(key) ?? [])

				return {
					serviceName: row.serviceName,
					serviceNamespace: row.serviceNamespace,
					environment: row.environment,
					p50LatencyMs: row.p50LatencyMs,
					p95LatencyMs: row.p95LatencyMs,
					p99LatencyMs: row.p99LatencyMs,
					errorRate: row.errorRate,
					throughput: row.throughput,
					tracedThroughput: row.tracedThroughput,
					hasSampling: row.hasSampling,
					samplingWeight: row.samplingWeight,
					spanCount: row.spanCount,
					errorCount: Math.round(row.errorRate * row.spanCount),
					health: deriveServiceHealth({
						errorRate: row.errorRate,
						p95LatencyMs: row.p95LatencyMs,
						spanCount: row.spanCount,
						baseline: usable,
					}),
					delta: baselineDelta(row.p95LatencyMs, usable, windowLabel),
					version: version?.version ?? "",
					versionFirstSeen: version?.firstSeen ?? "",
					commitSha: commitSha ?? "",
				}
			})

			return { rows, comparedCount, series }
		},
	})
}
