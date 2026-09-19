import { describe, expect, it } from "@effect/vitest"
import { compileUnsafe } from "@maple-dev/clickhouse-builder"
import { DEPLOYMENT_ENV_SQL } from "@maple/domain/tinybird/semconv-renames"
import { serviceCatalogVersionsQuery } from "./service-catalog-versions"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
}

const compile = (opts?: Parameters<typeof serviceCatalogVersionsQuery>[0]) =>
	compileUnsafe(serviceCatalogVersionsQuery(opts), baseParams)

describe("serviceCatalogVersionsQuery", () => {
	it("scopes by org and the whole window", () => {
		const { sql } = compile()
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("Timestamp >= toDateTime('2024-01-01 00:00:00')")
		expect(sql).toContain("Timestamp < toDateTime('2024-01-02 00:00:00')")
	})

	it("derives a single-tenant scope from its own predicate", () => {
		expect(compile().tenantScope).toBe("single-tenant")
	})

	it("reads raw traces — no tier carries service.version", () => {
		const { sql } = compile()
		expect(sql).toContain("FROM traces")
		expect(sql).not.toContain("service_overview_hourly")
		expect(sql).not.toContain("service_overview_spans")
	})

	it("narrows to the entry-point population the overview tiers project", () => {
		expect(compile().sql).toContain("IsEntryPoint = 1")
	})

	it("derives the environment with the canonical semconv coalesce", () => {
		// Byte-identical to what `service_overview_spans_mv` writes into
		// `DeploymentEnv`, so a version row and an overview row agree on which
		// environment they describe.
		expect(compile().sql).toContain(DEPLOYMENT_ENV_SQL)
	})

	it("drops unversioned spans before the GROUP BY", () => {
		const { sql } = compile()
		expect(sql).toContain("ResourceAttributes['service.version'] != ''")
		expect(sql.indexOf("ResourceAttributes['service.version'] != ''")).toBeLessThan(
			sql.indexOf("GROUP BY"),
		)
	})

	it("keeps the environment in the grouping key", () => {
		// A version is a property of a deployment: collapsing to the service alone
		// would report staging's release as production's.
		expect(compile().sql).toContain("GROUP BY serviceName, environment, version")
	})

	it("orders the still-live version first", () => {
		expect(compile().sql).toContain("ORDER BY lastSeen DESC, spanCount DESC")
	})

	it("returns the boundary timestamps as text", () => {
		const { sql } = compile()
		expect(sql).toContain("toString(min(Timestamp)) AS firstSeen")
		expect(sql).toContain("toString(max(Timestamp)) AS lastSeen")
	})

	it("scopes to one service when asked, and to the fleet otherwise", () => {
		expect(compile({ serviceName: "artifacts-api" }).sql).toContain("ServiceName = 'artifacts-api'")
		expect(compile().sql).not.toContain("ServiceName =")
	})

	it("caps the row count", () => {
		expect(compile().sql).toContain("LIMIT 500")
		expect(compile({ limit: 25 }).sql).toContain("LIMIT 25")
	})
})
