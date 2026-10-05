// The header's project, resolved to its services, reaching the queries that
// have no namespace column of their own.
import { describe, expect, it } from "vitest"
import { compileUnionUnsafe, compileUnsafe } from "@maple-dev/effect-clickhouse"
import { errorSessionsQuery } from "./errors"
import {
	sessionReplaysFacetsQuery,
	sessionReplaysListQuery,
	sessionResourceAttributeBreakdownQuery,
} from "./session-replays"
import { webAnalyticsSummaryQuery } from "./web-analytics"
import {
	listMetricsQuery,
	metricsBreakdownQuery,
	metricsSparklinesQuery,
	metricsTimeseriesQuery,
} from "./metrics"

const params = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
	metricName: "m",
	bucketSeconds: 3600,
}
const SERVICES = ["git-smoke-api", "git-smoke-browser"]
const IN = "ServiceName IN ('git-smoke-api', 'git-smoke-browser')"

describe("project scope by service list", () => {
	it("narrows the sessions list, every facet branch, and the location breakdown", () => {
		expect(compileUnsafe(sessionReplaysListQuery({ services: SERVICES }), params).sql).toContain(IN)
		const facets = compileUnionUnsafe(sessionReplaysFacetsQuery({ services: SERVICES }), params).sql
		const branches = facets.split("FROM session_replays").length - 1
		expect(facets.split(IN).length - 1).toBeGreaterThanOrEqual(branches)
		const breakdown = sessionResourceAttributeBreakdownQuery({
			key: "geo.locality.name",
			services: SERVICES,
		})
		expect(compileUnsafe(breakdown, params).sql).toContain(IN)
	})

	it("narrows web analytics through the session semi-join", () => {
		const { sql } = compileUnsafe(webAnalyticsSummaryQuery({ services: SERVICES }), params)
		expect(sql).toContain(IN)
	})

	it("narrows the metrics list, detail series, breakdown and sparklines", () => {
		expect(compileUnsafe(listMetricsQuery({ services: SERVICES }), params).sql).toContain(IN)
		expect(
			compileUnsafe(metricsTimeseriesQuery({ metricType: "sum", services: SERVICES }), params).sql,
		).toContain(IN)
		expect(
			compileUnsafe(metricsBreakdownQuery({ metricType: "sum", services: SERVICES }), params).sql,
		).toContain(IN)
		const spark = metricsSparklinesQuery({
			metricType: "sum",
			metricNames: ["m"],
			services: SERVICES,
			environments: ["unknown"],
		})
		const sql = compileUnsafe(spark, params).sql
		expect(sql).toContain(IN)
		expect(sql).toContain("'unknown') IN ('unknown')")
	})

	it("keeps only the project's sessions among those that hit an error", () => {
		const q = errorSessionsQuery({ fingerprintHash: "123", messageMatch: "boom", services: SERVICES })
		const { sql } = compileUnsafe(q, params)
		expect(sql).toMatch(/SessionId IN \(SELECT\s+SessionId/)
		expect(sql).toContain(IN)
	})

	it("matches nothing for a project with no services, rather than everything", () => {
		expect(compileUnsafe(sessionReplaysListQuery({ services: [] }), params).sql).toContain("1 = 0")
		expect(compileUnsafe(listMetricsQuery({ services: [] }), params).sql).toContain("1 = 0")
	})

	it("adds nothing when no project is selected", () => {
		expect(compileUnsafe(sessionReplaysListQuery({}), params).sql).not.toContain("ServiceName IN")
		expect(compileUnsafe(listMetricsQuery({}), params).sql).not.toContain("ServiceName IN")
	})
})
