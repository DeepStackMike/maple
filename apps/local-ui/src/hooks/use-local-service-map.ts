import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"
import { boundsForRange } from "../lib/time"

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
}

/**
 * The whole map: service→service edges, per-service totals, and the database
 * edges drawn as their own nodes.
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
 */
export function useLocalServiceMap({ range, env }: { range?: string; env?: string }) {
	return useQuery({
		queryKey: ["local", "service-map", range, env ?? null],
		placeholderData: keepPreviousData,
		queryFn: async (): Promise<ServiceMapData> => {
			const { startTime, endTime } = boundsForRange(range)
			const params = { orgId: LOCAL_ORG_ID, startTime, endTime }
			const [edgeRows, nodeRows, dbEdgeRows] = await Promise.all([
				executeLocalCompiledQuery(
					CH.compile(CH.serviceMapEdgesQuery({ deploymentEnv: env }), params),
				),
				executeLocalCompiledQuery(
					CH.compile(CH.serviceMapNodeStatsQuery({ deploymentEnv: env }), params),
				),
				executeLocalCompiledQuery(CH.serviceDbEdgesSQL({ deploymentEnv: env }, params)).catch(
					() => null,
				),
			])

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

			for (const node of nodes.values()) {
				if (node.kind === "database" && node.spanCount > 0) {
					nodes.set(node.id, { ...node, errorRate: node.errorCount / node.spanCount })
				}
			}

			return {
				nodes: [...nodes.values()],
				edges,
				maxCallCount: Math.max(0, ...edges.map((e) => e.callCount)),
				dbEdgesUnavailable: dbEdgeRows === null,
			}
		},
	})
}
