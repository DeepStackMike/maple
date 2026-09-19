// Web analytics over `session_replays` + `session_events` — the tables the
// browser SDK's session recorder writes, read through the same builders the
// cloud `/analytics` route uses.
//
// Two things are deliberately not here. The **summary** is
// `useLocalSessionsSummary` from `use-local-home.ts`: Home already runs
// `webAnalyticsSummaryQuery` for its Sessions tile, and sharing the hook makes
// the strip's headline the number Home reports and its fetch a cache hit. The
// **error sessions** count is `useLocalSessionFacets` from
// `use-local-sessions.ts` for the same reason — it is the sessions tab's own
// "with errors" figure, and the strip must not disagree with the list it links
// to.
//
// Every builder is compiled with the page-level filter surface left empty: the
// Local tab has no acquisition sidebar, so a breakdown row is a link to the
// sessions list rather than a filter over this page.

import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { boundsForRange } from "../lib/time"
import { groupFacets, type FacetRow, type PageviewsPoint, type SessionsPoint } from "../lib/web-analytics"
import { bucketSecondsForRange } from "./use-local-metrics"

/** Rows per breakdown card. The cards show a handful and the table scrolls; 50 is the builder's own default. */
const BREAKDOWN_LIMIT = 50

/** Top pages. Same limit the cloud route passes. */
const PAGES_LIMIT = 100

/**
 * Page views are read from raw `session_events`, never from the `product_events`
 * rollup (`useProductEvents` stays unset, as it does on every cloud call site).
 *
 * The two paths are held to byte-identical results by the parity e2e, so this
 * is not a correctness hedge — it is a coverage one. The rollup is a
 * materialized view, and an MV only fires on insert: a row written before the
 * v11 store bump added it is in `session_events` and not in `product_events`.
 * Reading raw makes the page-view count a superset that cannot be short, and at
 * local volumes the scan it saves is not worth the class of bug it buys.
 */
const PAGEVIEW_SOURCE = { useProductEvents: false } as const

/** Sessions per bucket, from `session_replays`, bucketed on the session's start. */
export function useLocalWebSessionsTimeseries(range: string | undefined) {
	return useQuery({
		queryKey: ["local", "web-analytics", "sessions-timeseries", range],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<SessionsPoint>> => {
			const { startTime, endTime } = boundsForRange(range)
			const bucketSeconds = bucketSecondsForRange(range)
			return executeLocalCompiledQuery(
				CH.compile(CH.webAnalyticsTimeseriesQuery({ bucketSeconds }), {
					orgId: LOCAL_ORG_ID,
					startTime,
					endTime,
				}),
			)
		},
	})
}

/** Page views per bucket, from the navigation rows of `session_events`. */
export function useLocalWebPageviewsTimeseries(range: string | undefined) {
	return useQuery({
		queryKey: ["local", "web-analytics", "pageviews-timeseries", range],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<PageviewsPoint>> => {
			const { startTime, endTime } = boundsForRange(range)
			const bucketSeconds = bucketSecondsForRange(range)
			return executeLocalCompiledQuery(
				CH.compile(CH.webAnalyticsPageviewsTimeseriesQuery({ bucketSeconds, ...PAGEVIEW_SOURCE }), {
					orgId: LOCAL_ORG_ID,
					startTime,
					endTime,
				}),
			)
		},
	})
}

/**
 * Most-viewed pages, host + pathname.
 *
 * The only dimension on the page with a real page-view count, and the only one
 * with full coverage: it reads `session_events`, which every session writes,
 * where Entries and Exits beside it come from the analytics block and do not.
 */
export function useLocalWebPages(range: string | undefined) {
	return useQuery({
		queryKey: ["local", "web-analytics", "pages", range],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<CH.WebAnalyticsPagesOutput>> => {
			const { startTime, endTime } = boundsForRange(range)
			return executeLocalCompiledQuery(
				CH.compile(CH.webAnalyticsPagesQuery({ limit: PAGES_LIMIT, ...PAGEVIEW_SOURCE }), {
					orgId: LOCAL_ORG_ID,
					startTime,
					endTime,
				}),
			)
		},
	})
}

/**
 * Every audience and acquisition dimension in one round trip.
 *
 * `webAnalyticsBreakdownsQuery` is a twelve-branch `UNION ALL` over
 * `session_replays` discriminated by `facetType`; nine of the cards on the page
 * read one key of the grouped result, so one query backs all of them. Grouped
 * in the query function rather than in the component so the split happens once
 * per fetch instead of once per render.
 */
export function useLocalWebBreakdowns(range: string | undefined) {
	return useQuery({
		queryKey: ["local", "web-analytics", "breakdowns", range],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyMap<string, ReadonlyArray<FacetRow>>> => {
			const { startTime, endTime } = boundsForRange(range)
			const rows = await executeLocalCompiledQuery(
				CH.compileUnion(CH.webAnalyticsBreakdownsQuery({ limitPerDimension: BREAKDOWN_LIMIT }), {
					orgId: LOCAL_ORG_ID,
					startTime,
					endTime,
				}),
			)
			return groupFacets(rows)
		},
	})
}

/**
 * One `ResourceAttributes` key of the session, ranked by sessions.
 *
 * The geography the Countries card shows stops at the country: `Country` is a
 * column, resolved once at the ingest gateway from an edge header. Anything
 * finer arrives as OpenTelemetry geo keys in the session's resource map, which
 * has no column and no facet branch — hence its own builder and its own round
 * trip per card rather than two more arms on the union.
 *
 * `qualifierKey` is what makes a region row readable: `TX` is an ISO 3166-2
 * subdivision code, unique only inside its country, so the Regions card pairs
 * it with `geo.country.iso_code` and reads `US-TX`. Resolving that in SQL keeps
 * this a single query — see `sessionResourceAttributeBreakdownQuery`.
 */
export function useLocalSessionAttributeBreakdown(
	range: string | undefined,
	attribute: { readonly key: string; readonly qualifierKey?: string },
) {
	return useQuery({
		queryKey: [
			"local",
			"web-analytics",
			"session-attribute",
			attribute.key,
			attribute.qualifierKey ?? null,
			range,
		],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<CH.SessionResourceAttributeBreakdownOutput>> => {
			const { startTime, endTime } = boundsForRange(range)
			return executeLocalCompiledQuery(
				CH.compile(
					CH.sessionResourceAttributeBreakdownQuery({ ...attribute, limit: BREAKDOWN_LIMIT }),
					{ orgId: LOCAL_ORG_ID, startTime, endTime },
				),
			)
		},
	})
}
