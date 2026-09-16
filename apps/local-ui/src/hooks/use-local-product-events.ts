// Product analytics over `product_events` — the table the `session_events` MV
// projects every browser page view and `track()` call into.
//
// Every hook here compiles a builder from `@maple/query-engine/ch` unchanged;
// local mode differs only in the tenant (`LOCAL_ORG_ID`) and in leaving the
// page-level filter surface (`ProductEventsFilters`) empty, since the Analytics
// tab has no acquisition sidebar to narrow by.

import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { boundsForRange } from "../lib/time"
import { bucketSecondsForRange } from "./use-local-metrics"
import { isRunnableFunnel } from "../lib/product-analytics"

/**
 * What a funnel counts in local mode.
 *
 * `session` rather than `person`: the person key resolves to `UserId`, then to
 * the visitor's linked user, then to `VisitorId`, and drops rows where all
 * three are empty. The browser SDK only writes the first two once the app calls
 * `identify()`, which a local dev app typically never does, so a person-keyed
 * funnel on a fresh `maple start` reports zero at every step. `SessionId` is on
 * every browser row by construction. (Server-side events carry no session and
 * so never take part — the same trade the engine documents for this key.)
 */
const FUNNEL_KEY_BY = "session" as const

/** One distinct event name in range. Mirrors `CH.ProductEventNamesOutput`. */
export interface ProductEventName {
	readonly eventName: string
	/** `custom` for a `track()` call, `navigation` for a page view. */
	readonly kind: string
	readonly count: number
	readonly sessions: number
	/** Distinct visitors/users — 0 until an app calls `identify()`. */
	readonly persons: number
	readonly lastSeen: string
}

/**
 * Every product event name in range with its volume, reach and recency.
 *
 * Also the source for the funnel step picker, which is why it is keyed on the
 * range alone: both panels read the same list, from one query.
 */
export function useLocalProductEventNames(range: string | undefined) {
	return useQuery({
		queryKey: ["local", "product-events", "names", range],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<ProductEventName>> => {
			const { startTime, endTime } = boundsForRange(range)
			const compiled = CH.compile(CH.productEventNamesQuery({ limit: 200 }), {
				orgId: LOCAL_ORG_ID,
				startTime,
				endTime,
			})
			return executeLocalCompiledQuery(compiled)
		},
	})
}

export interface ProductEventPoint {
	readonly bucket: string
	readonly count: number
	readonly sessions: number
}

/** One event's firings per bucket, at the same ~60-bucket resolution as the metric charts. */
export function useLocalProductEventTimeseries(eventName: string | null, range: string | undefined) {
	return useQuery({
		queryKey: ["local", "product-events", "timeseries", eventName, range],
		enabled: eventName !== null,
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<ProductEventPoint>> => {
			const { startTime, endTime } = boundsForRange(range)
			const compiled = CH.compile(
				CH.productEventTimeseriesQuery({
					eventName: eventName!,
					bucketSeconds: bucketSecondsForRange(range),
				}),
				{ orgId: LOCAL_ORG_ID, startTime, endTime },
			)
			return executeLocalCompiledQuery(compiled)
		},
	})
}

export interface ProductEventPropertyKey {
	readonly propertyKey: string
	/** Firings carrying this key — below the event's total when it is set conditionally. */
	readonly count: number
}

/** The property keys one event carries, most common first: the breakdown picker. */
export function useLocalProductEventPropertyKeys(eventName: string | null, range: string | undefined) {
	return useQuery({
		queryKey: ["local", "product-events", "property-keys", eventName, range],
		enabled: eventName !== null,
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<ProductEventPropertyKey>> => {
			const { startTime, endTime } = boundsForRange(range)
			const compiled = CH.compile(CH.productEventPropertyKeysQuery({ eventName: eventName! }), {
				orgId: LOCAL_ORG_ID,
				startTime,
				endTime,
			})
			return executeLocalCompiledQuery(compiled)
		},
	})
}

export interface ProductEventPropertyValue {
	readonly propertyValue: string
	readonly count: number
	readonly sessions: number
}

/** Top values of one property on one event. Firings that never set it are excluded. */
export function useLocalProductEventPropertyValues(
	eventName: string | null,
	propertyKey: string | null,
	range: string | undefined,
) {
	return useQuery({
		queryKey: ["local", "product-events", "property-values", eventName, propertyKey, range],
		enabled: eventName !== null && propertyKey !== null && propertyKey !== "",
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<ProductEventPropertyValue>> => {
			const { startTime, endTime } = boundsForRange(range)
			const compiled = CH.compile(
				CH.productEventPropertyValuesQuery({ eventName: eventName!, propertyKey: propertyKey! }),
				{ orgId: LOCAL_ORG_ID, startTime, endTime },
			)
			return executeLocalCompiledQuery(compiled)
		},
	})
}

export interface FunnelStepCount {
	readonly step: number
	readonly count: number
}

/**
 * Run the picked funnel: one `{ step, count }` row per step, in step order.
 *
 * Disabled until the definition is runnable, so a half-built funnel never
 * reaches the builder — which validates synchronously and throws.
 */
export function useLocalProductEventFunnel(
	steps: ReadonlyArray<string>,
	windowSeconds: number,
	range: string | undefined,
) {
	return useQuery({
		queryKey: ["local", "product-events", "funnel", steps, windowSeconds, range],
		enabled: isRunnableFunnel(steps),
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ReadonlyArray<FunnelStepCount>> => {
			const { startTime, endTime } = boundsForRange(range)
			const compiled = CH.compile(
				CH.productEventsFunnelQuery({
					steps: steps.map((eventName) => ({ kind: "event" as const, eventName })),
					keyBy: FUNNEL_KEY_BY,
					windowSeconds,
				}),
				{ orgId: LOCAL_ORG_ID, startTime, endTime },
			)
			return executeLocalCompiledQuery(compiled)
		},
	})
}
