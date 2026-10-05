import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-clickhouse"
import { namespaceServicesQuery, resourceNamespacesQuery } from "./namespaces"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
}

const SOURCES = ["traces", "logs", "session_replays", "metrics_sum", "metrics_gauge", "metrics_histogram"]

describe("resourceNamespacesQuery", () => {
	// Spans alone would hide a project that only records sessions or logs, and a
	// selector that cannot offer a project is worse than one that costs a scan.
	it("reads the namespace off every signal that carries a resource map", () => {
		const { sql } = compileUnsafe(resourceNamespacesQuery(), baseParams)
		for (const table of SOURCES) expect(sql).toContain(`FROM ${table}`)
		expect(sql.match(/OrgId = 'org_1'/g)).toHaveLength(SOURCES.length)
		expect(sql).toContain("StartTime >=")
		expect(sql).toContain("TimeUnix >=")
	})

	// A service that set no namespace is not a project called "" — it is what
	// "All projects" is the only way to see.
	it("drops the rows that set no namespace", () => {
		const { sql } = compileUnsafe(resourceNamespacesQuery(), baseParams)
		expect(sql.match(/ResourceAttributes\['service\.namespace'\] != ''/g)).toHaveLength(SOURCES.length)
	})

	it("offers the busiest project first, and caps the list", () => {
		const { sql } = compileUnsafe(resourceNamespacesQuery(), baseParams)
		expect(sql).toContain("ORDER BY spanCount DESC, namespace ASC")
		expect(sql).toContain("LIMIT 100")
		expect(compileUnsafe(resourceNamespacesQuery({ limit: 5 }), baseParams).sql).toContain("LIMIT 5")
	})
})

describe("namespaceServicesQuery", () => {
	it("lists the services that named the project on any signal", () => {
		const { sql } = compileUnsafe(namespaceServicesQuery({ namespace: "git-smoke" }), baseParams)
		for (const table of SOURCES) expect(sql).toContain(`FROM ${table}`)
		expect(sql.match(/ResourceAttributes\['service\.namespace'\] = 'git-smoke'/g)).toHaveLength(
			SOURCES.length,
		)
		expect(sql).toContain("GROUP BY serviceName")
	})

	it("escapes the namespace", () => {
		const { sql } = compileUnsafe(namespaceServicesQuery({ namespace: "it's" }), baseParams)
		expect(sql).toContain("'it\\'s'")
	})
})
