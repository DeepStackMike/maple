// The two queries Home needs that no other tab already runs.
//
// Everything else on the page is a tab's own hook called with Home's range —
// `useLocalServiceCatalog`, `useLocalErrorsSummary`, `useLocalErrorsByType`,
// `useLocalSessions` — so the tiles agree with the views they link to by
// construction, and opening one lands on a warm cache rather than a spinner.

import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { Option } from "effect"
import { executeLocalCompiledFirstRow, executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { namespaceFilter } from "../lib/namespace"
import { boundsForRange } from "../lib/time"
import type { OverviewPoint } from "../lib/home-overview"
import { bucketSecondsForRange } from "./use-local-metrics"

/**
 * Org-wide throughput and error rate per bucket, split by service.
 *
 * `tracesTimeseriesQuery` with `rootOnly` and a service group-by is the same
 * route the cloud dashboard's Request Volume / Error Rate tiles take: it reads
 * the `service_overview_spans` projection spliced with the
 * `service_overview_minutely` / `_hourly` rollups, so a wide range costs a
 * rollup scan rather than a per-span one.
 *
 * Split by service rather than aggregated in SQL because the page needs both
 * cuts and this is the cheaper way to get them: the chart sums the services
 * back together (`overviewSeries`) and the services table reads each one's
 * latest non-empty bucket as "last seen" (`lastSeenByService`). One query, two
 * blocks — and local mode's service count is small enough that the extra rows
 * are free.
 *
 * `namespace` scopes it to one project. It costs the rollup: `namespaces` makes
 * `canUseTracesAggregatesMv` bail, because `traces_aggregates_hourly` carries no
 * `ServiceNamespace` column and answering from it would silently ignore the
 * filter. The query lands on `service_overview_spans` instead, which does carry
 * it — a more expensive scan than the hourly rollup and a far cheaper one than
 * raw `traces`, and the only one of the three that can answer correctly.
 */
export function useLocalOverviewTimeseries(range: string | undefined, namespace?: string) {
	return useQuery({
		queryKey: ["local", "home", "overview-timeseries", range, namespace],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<OverviewPoint>> => {
			const { startTime, endTime } = boundsForRange(range)
			const bucketSeconds = bucketSecondsForRange(range)
			const rows = await executeLocalCompiledQuery(
				CH.compile(
					CH.tracesTimeseriesQuery({
						metric: "count",
						// The chart wants throughput and the table wants the error
						// rate; `allMetrics` returns both from the one scan.
						allMetrics: true,
						needsSampling: true,
						// Entry-point spans only — the same population
						// `serviceCatalogQuery` counts, so the chart's area and the
						// "Spans" tile describe the same thing.
						rootOnly: true,
						bucketSeconds,
						groupBy: ["service"],
						namespaces: namespaceFilter(namespace),
					}),
					{ orgId: LOCAL_ORG_ID, startTime, endTime, bucketSeconds },
				),
			)
			return rows.map((row) => ({
				bucket: row.bucket,
				serviceName: row.groupName,
				count: Number(row.count),
				errorRate: Number(row.errorRate),
			}))
		},
	})
}

/**
 * Headline session counts for the KPI strip.
 *
 * `webAnalyticsSummaryQuery` is a single group-less aggregate over
 * `session_replays`; the sessions list has no count of its own (it pages by
 * keyset), and summing the facet query's service branch would silently drop any
 * session recorded without a `service.name`.
 */
export function useLocalSessionsSummary(range: string | undefined) {
	return useQuery({
		queryKey: ["local", "home", "sessions-summary", range],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<CH.WebAnalyticsSummaryOutput | null> => {
			const { startTime, endTime } = boundsForRange(range)
			const row = await executeLocalCompiledFirstRow(
				CH.compile(CH.webAnalyticsSummaryQuery({}), {
					orgId: LOCAL_ORG_ID,
					startTime,
					endTime,
				}),
			)
			return Option.getOrNull(row)
		},
	})
}
