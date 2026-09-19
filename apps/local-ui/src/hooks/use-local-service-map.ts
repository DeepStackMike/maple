import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { TIME_RANGES, toClickHouseDateTime } from "../lib/time"

export type ServiceMapNodeKind = "service" | "database"

export interface ServiceMapNode {
	/** `svc:<name>` or `db:<system>:<namespace>` — unique across both kinds. */
	readonly id: string
	readonly label: string
	readonly kind: ServiceMapNodeKind
	/** Service nodes only: the name the service-detail route takes. */
	readonly serviceName?: string
	/** Database nodes only. */
	readonly dbSystem?: string
	/** Spans for a service, inbound calls for a database. */
	readonly spanCount: number
	readonly errorCount: number
	readonly errorRate: number
	readonly p95Ms: number
	/**
	 * Call-weighted mean latency of the calls made TO this node, or `null` when
	 * nothing in the window called it.
	 *
	 * Not a column of `serviceMapNodeStatsQuery` — that query selects a count, an
	 * error count and a p95, and it is shared with the cloud read path. The
	 * inbound edges already carry callee-side `avgDurationMs` over the same rows
	 * and the same window, so the mean of those weighted by call volume is the
	 * same number the query would have returned, without a schema change. A node
	 * nothing calls (the browser, an edge worker, a cron) genuinely has no
	 * inbound latency, and the card shows a dash rather than a zero.
	 */
	readonly avgMs: number | null
	/** p95 over the window immediately before this one, for the footer's insight. */
	readonly previousP95Ms: number | null
}

export interface ServiceMapEdge {
	readonly id: string
	readonly source: string
	readonly target: string
	readonly callCount: number
	readonly errorCount: number
	readonly errorRate: number
	readonly avgMs: number
	readonly p95Ms: number
	readonly kind: ServiceMapNodeKind
}

/** The stretch of time the map's numbers are rates over. */
export interface ServiceMapWindow {
	/** The window's nominal length — the denominator for every per-second rate. */
	readonly seconds: number
	/** Short, uppercase, for the header and footer strips: `60S`, `1H`, `7D`. */
	readonly label: string
	readonly live: boolean
}

export interface ServiceMapData {
	readonly nodes: readonly ServiceMapNode[]
	readonly edges: readonly ServiceMapEdge[]
	/** Widest edge in the drawing — the denominator for stroke width. */
	readonly maxCallCount: number
	/**
	 * The database overlay asked for its rows and did not get them. The service
	 * graph is still complete; only DB nodes are missing.
	 */
	readonly dbEdgesUnavailable: boolean
	readonly window: ServiceMapWindow
}

/** Live mode's window, and the interval it is re-read on. */
const LIVE_WINDOW_SECONDS = 60
const LIVE_REFETCH_MS = 5_000

/**
 * The skew pad `boundsForRange` applies to every range: a collector whose clock
 * runs ahead writes spans stamped in the future, and a window that ends `now`
 * drops them. Live mode needs it most — an hour of skew silently empties a
 * sixty-second window — so the pad is the same hour, and is deliberately NOT
 * part of `seconds`: rates divide by the window that was asked for.
 */
const CLOCK_SKEW_PAD_MS = 60 * 60 * 1000

interface Window {
	readonly startTime: string
	readonly endTime: string
	readonly seconds: number
	readonly label: string
}

/**
 * The window on screen, and the one before it.
 *
 * Live mode is not a range preset: it is always the last sixty seconds, whatever
 * the range select says, which is why it resolves here rather than as a
 * `TIME_RANGES` entry the select would then have to hide.
 */
function resolveWindows(
	range: string | undefined,
	live: boolean,
	anchorMs: number,
): { current: Window; previous: Window } {
	const preset = TIME_RANGES.find((r) => r.key === range) ?? TIME_RANGES[TIME_RANGES.length - 1]
	const seconds = live ? LIVE_WINDOW_SECONDS : preset.minutes * 60
	const label = live ? "60S" : preset.key.toUpperCase()
	const lengthMs = seconds * 1000
	return {
		current: {
			startTime: toClickHouseDateTime(anchorMs - lengthMs),
			endTime: toClickHouseDateTime(anchorMs + CLOCK_SKEW_PAD_MS),
			seconds,
			label,
		},
		// The previous window ends where this one starts, and is not padded: its
		// only job is to be the same length over the time just before.
		previous: {
			startTime: toClickHouseDateTime(anchorMs - lengthMs * 2),
			endTime: toClickHouseDateTime(anchorMs - lengthMs),
			seconds,
			label,
		},
	}
}

/**
 * The whole map: service→service edges, per-service totals, the database edges
 * drawn as their own nodes, and the previous window's p95 per service.
 *
 * **Why not `serviceDependenciesSQL`.** That builder — the one the cloud map and
 * the MCP tool use — takes every whole hour of the window from
 * `service_map_edges_hourly` and only the two partial hours at the ends from raw
 * spans. Nothing writes that rollup in local mode: its only writer is the MV
 * forwarding rows that `ServiceMapRollupService` POSTs from `apps/api`, into a
 * `Null` table. On a local store the sealed branch is empty, so a 7-day window
 * would draw whatever fell in two partial hours and say nothing about the rest.
 * `serviceMapEdgesQuery` is the same parent⋈child join with the rollup tier
 * dropped and the window left whole.
 *
 * Database edges still come from `serviceDbEdgesSQL`, which splices
 * `service_map_db_edges_hourly` — and THAT rollup is filled by a materialized
 * view (`service_map_db_edges_hourly_mv`) that local mode does run, so its
 * sealed hours are real. They ride their own `catch` because a missing database
 * overlay is worth far less than the service graph it sits on.
 *
 * **The fourth query is the previous window's node stats**, the same builder
 * over the preceding stretch of the same length. It is what lets the footer say
 * a service got slower rather than only how slow it is, and it is a count-and-
 * quantile over one table — the cheapest of the four. It rides a `catch` too:
 * an insight is a sentence, and the map under it is the tab.
 */
export function useLocalServiceMap({
	range,
	env,
	live = false,
}: {
	range?: string
	env?: string
	live?: boolean
}) {
	return useQuery({
		queryKey: ["local", "service-map", range, env ?? null, live],
		placeholderData: keepPreviousData,
		// Live mode re-reads on a timer; every other window is a fixed stretch of
		// the past and re-reading it produces the same rows.
		refetchInterval: live ? LIVE_REFETCH_MS : false,
		queryFn: async (): Promise<ServiceMapData> => {
			const { current, previous } = resolveWindows(range, live, Date.now())
			const params = {
				orgId: LOCAL_ORG_ID,
				startTime: current.startTime,
				endTime: current.endTime,
			}
			const [edgeRows, nodeRows, dbEdgeRows, previousNodeRows] = await Promise.all([
				executeLocalCompiledQuery(
					CH.compile(CH.serviceMapEdgesQuery({ deploymentEnv: env }), params),
				),
				executeLocalCompiledQuery(
					CH.compile(CH.serviceMapNodeStatsQuery({ deploymentEnv: env }), params),
				),
				executeLocalCompiledQuery(CH.serviceDbEdgesSQL({ deploymentEnv: env }, params)).catch(
					() => null,
				),
				executeLocalCompiledQuery(
					CH.compile(CH.serviceMapNodeStatsQuery({ deploymentEnv: env }), {
						orgId: LOCAL_ORG_ID,
						startTime: previous.startTime,
						endTime: previous.endTime,
					}),
				).catch(() => null),
			])

			const previousP95 = new Map(
				(previousNodeRows ?? []).map((row) => [row.serviceName, Number(row.p95DurationMs)]),
			)

			const serviceId = (name: string) => `svc:${name}`
			const nodes = new Map<string, ServiceMapNode>()

			const service = (name: string): ServiceMapNode => {
				const existing = nodes.get(serviceId(name))
				if (existing) return existing
				// Named by an edge but absent from the node stats — the two queries
				// cap independently, so a service past the stats' limit can still be
				// one end of a top edge. It belongs on the map; only its totals are
				// missing.
				const created: ServiceMapNode = {
					id: serviceId(name),
					label: name,
					kind: "service",
					serviceName: name,
					spanCount: 0,
					errorCount: 0,
					errorRate: 0,
					p95Ms: 0,
					avgMs: null,
					previousP95Ms: previousP95.get(name) ?? null,
				}
				nodes.set(created.id, created)
				return created
			}

			for (const row of nodeRows) {
				const spanCount = Number(row.spanCount)
				const errorCount = Number(row.errorCount)
				nodes.set(serviceId(row.serviceName), {
					id: serviceId(row.serviceName),
					label: row.serviceName,
					kind: "service",
					serviceName: row.serviceName,
					spanCount,
					errorCount,
					errorRate: spanCount > 0 ? errorCount / spanCount : 0,
					p95Ms: Number(row.p95DurationMs),
					avgMs: null,
					previousP95Ms: previousP95.get(row.serviceName) ?? null,
				})
			}

			const edges: ServiceMapEdge[] = []
			for (const row of edgeRows) {
				service(row.callerService)
				service(row.calleeService)
				const callCount = Number(row.callCount)
				const errorCount = Number(row.errorCount)
				edges.push({
					id: `${row.callerService}→${row.calleeService}`,
					source: serviceId(row.callerService),
					target: serviceId(row.calleeService),
					callCount,
					errorCount,
					errorRate: callCount > 0 ? errorCount / callCount : 0,
					avgMs: Number(row.avgDurationMs),
					p95Ms: Number(row.p95DurationMs),
					kind: "service",
				})
			}

			for (const row of dbEdgeRows ?? []) {
				const dbId = `db:${row.dbSystem}:${row.dbNamespace}`
				const callCount = Number(row.callCount)
				const errorCount = Number(row.errorCount)
				const p95Ms = Number(row.p95DurationMs) || Number(row.maxDurationMs)
				const existing = nodes.get(dbId)
				nodes.set(dbId, {
					id: dbId,
					label: row.dbNamespace || row.dbSystem,
					kind: "database",
					dbSystem: row.dbSystem,
					// A database's totals are the calls made TO it — it emits no spans
					// of its own, so there is nothing else to count.
					spanCount: (existing?.spanCount ?? 0) + callCount,
					errorCount: (existing?.errorCount ?? 0) + errorCount,
					errorRate: 0,
					p95Ms: Math.max(existing?.p95Ms ?? 0, p95Ms),
					avgMs: null,
					// A database is not a service: nothing reports its p95 to compare.
					previousP95Ms: null,
				})
				service(row.sourceService)
				edges.push({
					id: `${row.sourceService}→${dbId}`,
					source: serviceId(row.sourceService),
					target: dbId,
					callCount,
					errorCount,
					errorRate: callCount > 0 ? errorCount / callCount : 0,
					avgMs: Number(row.avgDurationMs),
					p95Ms,
					kind: "database",
				})
			}

			// Inbound latency, weighted by the calls it was measured over: a node
			// called a thousand times at 4 ms and twice at 900 ms averages 6 ms, not
			// 452 ms.
			const inbound = new Map<string, { weighted: number; calls: number }>()
			for (const edge of edges) {
				if (!(edge.avgMs > 0) || edge.callCount <= 0) continue
				const total = inbound.get(edge.target) ?? { weighted: 0, calls: 0 }
				total.weighted += edge.avgMs * edge.callCount
				total.calls += edge.callCount
				inbound.set(edge.target, total)
			}

			for (const node of nodes.values()) {
				const calls = inbound.get(node.id)
				const errorRate =
					node.kind === "database" && node.spanCount > 0
						? node.errorCount / node.spanCount
						: node.errorRate
				nodes.set(node.id, {
					...node,
					errorRate,
					avgMs: calls && calls.calls > 0 ? calls.weighted / calls.calls : null,
				})
			}

			return {
				nodes: [...nodes.values()],
				edges,
				maxCallCount: Math.max(0, ...edges.map((e) => e.callCount)),
				dbEdgesUnavailable: dbEdgeRows === null,
				window: { seconds: current.seconds, label: current.label, live },
			}
		},
	})
}
