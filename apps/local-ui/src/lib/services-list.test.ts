import { describe, expect, it } from "vitest"

import {
	baselineDelta,
	currentVersion,
	filterServiceRows,
	deriveServiceHealth,
	errorRateTone,
	formatThroughput,
	groupByEnvironment,
	healthRank,
	isServiceHealth,
	latencySeverity,
	rangeDurationSeconds,
	rangeWindowLabel,
	serviceCountLabel,
	serviceListFacets,
	serviceRowKey,
	type ServiceListRow,
} from "./services-list"

describe("errorRateTone", () => {
	it("walks the 1% / 5% ladder", () => {
		expect(errorRateTone(0)).toBe("ok")
		expect(errorRateTone(0.009)).toBe("ok")
		expect(errorRateTone(0.01)).toBe("warn")
		expect(errorRateTone(0.049)).toBe("warn")
		expect(errorRateTone(0.05)).toBe("crit")
	})
})

describe("latencySeverity", () => {
	it("falls back to absolute thresholds with no baseline", () => {
		expect(latencySeverity(999)).toBe("ok")
		expect(latencySeverity(1_000)).toBe("warn")
		expect(latencySeverity(3_000)).toBe("crit")
	})

	it("ignores a baseline built from too few spans", () => {
		// 10x the baseline, but the baseline is 40 spans — absolute ladder applies,
		// and 120ms clears it.
		expect(latencySeverity(120, 5_000, { p95LatencyMs: 12, spanCount: 40 })).toBe("ok")
	})

	it("judges against the baseline once it is dense enough", () => {
		const baseline = { p95LatencyMs: 400, spanCount: 5_000 }
		expect(latencySeverity(700, 5_000, baseline)).toBe("ok")
		expect(latencySeverity(800, 5_000, baseline)).toBe("warn")
		expect(latencySeverity(1_600, 5_000, baseline)).toBe("crit")
	})

	it("never flags below the 250ms absolute floor", () => {
		// 20ms → 200ms is 10x, and still nothing anyone can feel.
		expect(latencySeverity(200, 5_000, { p95LatencyMs: 20, spanCount: 5_000 })).toBe("ok")
	})

	it("stays quiet on a sparse current window", () => {
		expect(latencySeverity(9_000, 10)).toBe("ok")
	})
})

describe("deriveServiceHealth", () => {
	const dense = { spanCount: 5_000 }

	it("takes the worse of the two signals", () => {
		expect(deriveServiceHealth({ ...dense, errorRate: 0, p95LatencyMs: 10 })).toBe("healthy")
		expect(deriveServiceHealth({ ...dense, errorRate: 0.02, p95LatencyMs: 10 })).toBe("degraded")
		expect(deriveServiceHealth({ ...dense, errorRate: 0, p95LatencyMs: 4_000 })).toBe("unhealthy")
		// Latency is fine, errors are not — the worse one wins.
		expect(deriveServiceHealth({ ...dense, errorRate: 0.2, p95LatencyMs: 10 })).toBe("unhealthy")
	})

	it("uses the baseline when one is supplied", () => {
		const signals = { ...dense, errorRate: 0, p95LatencyMs: 1_200 }
		// Absolute ladder alone would call 1200ms degraded…
		expect(deriveServiceHealth(signals)).toBe("degraded")
		// …but this service has always been slow.
		expect(deriveServiceHealth({ ...signals, baseline: { p95LatencyMs: 1_100, spanCount: 9_000 } })).toBe(
			"healthy",
		)
	})

	it("ranks worse health higher", () => {
		expect(healthRank("unhealthy")).toBeGreaterThan(healthRank("degraded"))
		expect(healthRank("degraded")).toBeGreaterThan(healthRank("healthy"))
	})

	it("narrows a URL value to a health level", () => {
		expect(isServiceHealth("degraded")).toBe(true)
		expect(isServiceHealth("broken")).toBe(false)
	})
})

describe("baselineDelta", () => {
	const dense = { p95LatencyMs: 100, spanCount: 5_000 }

	it("withholds the line without a usable baseline", () => {
		expect(baselineDelta(100, undefined, "7d")).toBeUndefined()
		expect(baselineDelta(100, { p95LatencyMs: 100, spanCount: 20 }, "7d")).toBeUndefined()
		expect(baselineDelta(100, { p95LatencyMs: 0, spanCount: 5_000 }, "7d")).toBeUndefined()
	})

	it("names the window it compared against", () => {
		expect(baselineDelta(64, dense, "7d")?.label).toBe("-36% vs 7d")
		expect(baselineDelta(150, dense, "24h")?.label).toBe("+50% vs 24h")
	})

	it("says nothing when the move rounds to zero", () => {
		expect(baselineDelta(100.4, dense, "7d")).toBeUndefined()
	})

	it("paints regressions warm and improvements green", () => {
		expect(baselineDelta(210, dense, "7d")?.className).toBe("text-severity-error")
		expect(baselineDelta(150, dense, "7d")?.className).toBe("text-severity-warn")
		expect(baselineDelta(64, dense, "7d")?.className).toBe("text-success")
		expect(baselineDelta(103, dense, "7d")?.className).toBe("text-muted-foreground")
	})
})

describe("groupByEnvironment", () => {
	const rows = [
		{ environment: "development", serviceName: "d" },
		{ environment: "", serviceName: "none" },
		{ environment: "qa", serviceName: "q" },
		{ environment: "production", serviceName: "p1" },
		{ environment: "production", serviceName: "p2" },
		{ environment: "staging", serviceName: "s" },
	]

	it("orders production → staging → development → other → unlabelled", () => {
		expect(groupByEnvironment(rows).map(([env]) => env)).toEqual([
			"production",
			"staging",
			"development",
			"qa",
			"",
		])
	})

	it("keeps every row exactly once", () => {
		const grouped = groupByEnvironment(rows)
		expect(grouped.flatMap(([, group]) => group)).toHaveLength(rows.length)
		expect(grouped.find(([env]) => env === "production")?.[1].map((r) => r.serviceName)).toEqual([
			"p1",
			"p2",
		])
	})

	it("sorts unrecognised environments alphabetically among themselves", () => {
		const grouped = groupByEnvironment([
			{ environment: "zeta" },
			{ environment: "alpha" },
			{ environment: "unknown" },
		])
		expect(grouped.map(([env]) => env)).toEqual(["alpha", "zeta", "unknown"])
	})

	it("returns nothing for no rows", () => {
		expect(groupByEnvironment([])).toEqual([])
	})
})

describe("serviceCountLabel", () => {
	it("singularises one service", () => {
		expect(serviceCountLabel(1)).toBe("1 service")
		expect(serviceCountLabel(0)).toBe("0 services")
		expect(serviceCountLabel(16)).toBe("16 services")
	})
})

describe("formatThroughput", () => {
	it("keeps a sub-1/s rate readable", () => {
		expect(formatThroughput(0)).toBe("0/s")
		expect(formatThroughput(0.004)).toBe("0.004/s")
		expect(formatThroughput(12.34)).toBe("12.3/s")
		expect(formatThroughput(2_500)).toBe("2.5k/s")
	})
})

describe("range helpers", () => {
	it("resolves a range key to its own width, unpadded", () => {
		expect(rangeDurationSeconds("1h")).toBe(3_600)
		expect(rangeDurationSeconds("7d")).toBe(604_800)
	})

	it("falls back to the widest range for an unknown key", () => {
		expect(rangeDurationSeconds("nonsense")).toBe(rangeDurationSeconds("30d"))
		expect(rangeWindowLabel(undefined)).toBe("30d")
	})
})

describe("currentVersion", () => {
	it("returns nothing for a service that stamps no version", () => {
		expect(currentVersion([])).toBeUndefined()
	})

	it("picks the version still taking traffic, not the newest one seen", () => {
		const rolledBack = {
			version: "1.4.0",
			firstSeen: "2026-09-01 00:00:00",
			lastSeen: "2026-09-19 12:00:00",
			spanCount: 900,
		}
		const bad = {
			version: "1.5.0",
			firstSeen: "2026-09-19 09:00:00",
			lastSeen: "2026-09-19 09:30:00",
			spanCount: 50,
		}
		expect(currentVersion([bad, rolledBack])?.version).toBe("1.4.0")
	})

	it("breaks a tie on volume", () => {
		const straggler = { version: "1.4.0", firstSeen: "", lastSeen: "2026-09-19 12:00:00", spanCount: 3 }
		const fleet = { version: "1.5.0", firstSeen: "", lastSeen: "2026-09-19 12:00:00", spanCount: 800 }
		expect(currentVersion([straggler, fleet])?.version).toBe("1.5.0")
	})
})

describe("serviceRowKey", () => {
	it("keeps one service's environments apart", () => {
		expect(serviceRowKey("api", "production")).not.toBe(serviceRowKey("api", "staging"))
	})
})

describe("filterServiceRows / serviceListFacets", () => {
	const row = (over: Partial<ServiceListRow>): ServiceListRow => ({
		serviceName: "api",
		serviceNamespace: "",
		environment: "production",
		p50LatencyMs: 10,
		p95LatencyMs: 20,
		p99LatencyMs: 30,
		errorRate: 0,
		throughput: 1,
		tracedThroughput: 1,
		hasSampling: false,
		samplingWeight: 1,
		spanCount: 100,
		errorCount: 0,
		health: "healthy",
		delta: undefined,
		version: "",
		versionFirstSeen: "",
		commitSha: "",
		...over,
	})

	const rows = [
		row({ serviceName: "api", environment: "production", serviceNamespace: "backend", version: "1.2.0" }),
		row({
			serviceName: "web",
			environment: "production",
			serviceNamespace: "client",
			version: "1.2.0",
			health: "degraded",
		}),
		row({
			serviceName: "worker",
			environment: "staging",
			serviceNamespace: "backend",
			version: "1.3.0",
			health: "unhealthy",
		}),
		row({ serviceName: "probe", environment: "", serviceNamespace: "" }),
	]

	it("returns everything with no filters", () => {
		expect(filterServiceRows(rows, {})).toHaveLength(4)
	})

	it("narrows on each dimension, and on all of them together", () => {
		expect(filterServiceRows(rows, { env: "staging" }).map((r) => r.serviceName)).toEqual(["worker"])
		expect(filterServiceRows(rows, { ns: "backend" }).map((r) => r.serviceName)).toEqual([
			"api",
			"worker",
		])
		expect(filterServiceRows(rows, { version: "1.2.0" }).map((r) => r.serviceName)).toEqual([
			"api",
			"web",
		])
		expect(filterServiceRows(rows, { health: "unhealthy" }).map((r) => r.serviceName)).toEqual(["worker"])
		expect(
			filterServiceRows(rows, { env: "production", ns: "backend" }).map((r) => r.serviceName),
		).toEqual(["api"])
	})

	it("matches the name search case-insensitively, and ignores an empty one", () => {
		expect(filterServiceRows(rows, { search: "OR" }).map((r) => r.serviceName)).toEqual(["worker"])
		expect(filterServiceRows(rows, { search: "" })).toHaveLength(4)
	})

	it("always lists all three health levels, worst first, counting zeroes honestly", () => {
		expect(serviceListFacets(rows, {}).health).toEqual([
			{ name: "unhealthy", count: 1 },
			{ name: "degraded", count: 1 },
			{ name: "healthy", count: 2 },
		])
		expect(serviceListFacets(rows, { env: "production" }).health).toEqual([
			{ name: "unhealthy", count: 0 },
			{ name: "degraded", count: 1 },
			{ name: "healthy", count: 1 },
		])
	})

	it("counts a facet over the OTHER filters, never its own", () => {
		// With production ticked, Environment still offers staging at its real
		// count — otherwise ticking one value strands every other at zero.
		const facets = serviceListFacets(rows, { env: "production" })
		expect(facets.environments).toEqual([
			{ name: "production", count: 2 },
			{ name: "staging", count: 1 },
		])
		// Namespace, meanwhile, IS narrowed by the environment choice.
		expect(facets.namespaces).toEqual([
			{ name: "backend", count: 1 },
			{ name: "client", count: 1 },
		])
	})

	it("leaves an absent attribute out of its facet", () => {
		const facets = serviceListFacets(rows, {})
		expect(facets.environments.map((f) => f.name)).not.toContain("")
		expect(facets.namespaces.map((f) => f.name)).not.toContain("")
		expect(facets.versions.map((f) => f.name)).not.toContain("")
	})

	it("ranks facet values by count, then alphabetically", () => {
		expect(serviceListFacets(rows, {}).versions).toEqual([
			{ name: "1.2.0", count: 2 },
			{ name: "1.3.0", count: 1 },
		])
	})
})
