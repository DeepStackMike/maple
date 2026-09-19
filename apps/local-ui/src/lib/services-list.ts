// Pure helpers behind the Services list: health classification, the delta
// against the previous window, and the environment grouping the table renders.
//
// **The thresholds are copied, deliberately.** The originals live in
// `apps/web/src/components/dashboard/service-health.ts`, which the local SPA
// cannot import: it is inside another deployable, and it pulls in the alert /
// anomaly domain types that give hosted health its real inputs. Moving the
// constants into `packages/ui` to share them would drag the same types along,
// so the numbers are mirrored here and the module they came from is named so a
// change to one is findable from the other.
//
// **Hosted health and local health are not the same function, and that is not a
// shortfall of the copy.** `deriveServiceHealthFromCauses` grades a service on
// open alert incidents and seasonal anomalies — an operator's rule or Maple's
// detector having already decided. Local mode runs neither: no alerting service,
// no anomaly cron. What it has is the metric heuristic web keeps beside them
// (`deriveServiceHealth`), and that is what is mirrored here — the same error
// ladder, the same baseline-relative latency ladder, the same floors.

import { TIME_RANGES } from "./time"

export type SeverityLevel = "ok" | "warn" | "crit"

/** Health rollup for a single (service, environment) row. */
export type ServiceHealth = "healthy" | "degraded" | "unhealthy"

export const HEALTH_LEVELS: readonly ServiceHealth[] = ["unhealthy", "degraded", "healthy"]

export const isServiceHealth = (value: string): value is ServiceHealth =>
	(HEALTH_LEVELS as readonly string[]).includes(value)

// Error-rate thresholds are global absolutes — an error ratio means the same
// thing for every service. Error rate is a fraction (errors / requests).
const ERROR_RATE_DEGRADED = 0.01 // 1%
const ERROR_RATE_UNHEALTHY = 0.05 // 5%

// Absolute p95 thresholds (ms), the FALLBACK for a service with no usable
// baseline — otherwise latency is judged against the service's own previous
// window, so slow-by-design work (batch jobs, queue consumers) isn't
// permanently flagged for a p95 that is normal for it.
const P95_DEGRADED_MS = 1_000
const P95_UNHEALTHY_MS = 3_000

const LATENCY_BASELINE_DEGRADED_RATIO = 2
const LATENCY_BASELINE_UNHEALTHY_RATIO = 4
// Never latency-flag below this absolute floor — a 5ms→15ms move is 3× and
// harmless, and sub-floor p95s are dominated by noise.
const LATENCY_ABS_FLOOR_MS = 250
/** A baseline built from fewer spans than this is noise; treat it as absent. */
export const MIN_BASELINE_SPANS = 100
// Below this many spans in the current window the weighted p95 is too noisy to
// flag latency at all. Error rate still applies.
const MIN_CURRENT_SPANS = 50

export interface LatencyBaselineSignal {
	readonly p95LatencyMs: number
	readonly spanCount: number
}

export interface ServiceHealthSignals {
	readonly errorRate: number
	readonly p95LatencyMs: number
	readonly spanCount: number
	readonly baseline?: LatencyBaselineSignal | undefined
}

const SEVERITY_RANK: Record<SeverityLevel, number> = {
	ok: 0,
	warn: 1,
	crit: 2,
} satisfies Record<SeverityLevel, number>

const maxSeverity = (a: SeverityLevel, b: SeverityLevel): SeverityLevel =>
	SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b

/** Severity of an error-rate value on its own. */
export function errorRateTone(errorRate: number): SeverityLevel {
	if (errorRate >= ERROR_RATE_UNHEALTHY) return "crit"
	if (errorRate >= ERROR_RATE_DEGRADED) return "warn"
	return "ok"
}

/**
 * Severity of a p95, baseline-relative when the service has a usable baseline
 * and absolute-threshold otherwise.
 */
export function latencySeverity(
	p95LatencyMs: number,
	spanCount?: number,
	baseline?: LatencyBaselineSignal | undefined,
): SeverityLevel {
	if (spanCount !== undefined && spanCount < MIN_CURRENT_SPANS) return "ok"

	if (baseline !== undefined && baseline.spanCount >= MIN_BASELINE_SPANS && baseline.p95LatencyMs > 0) {
		const unhealthyAt = Math.max(
			LATENCY_ABS_FLOOR_MS,
			baseline.p95LatencyMs * LATENCY_BASELINE_UNHEALTHY_RATIO,
		)
		const degradedAt = Math.max(
			LATENCY_ABS_FLOOR_MS,
			baseline.p95LatencyMs * LATENCY_BASELINE_DEGRADED_RATIO,
		)
		if (p95LatencyMs >= unhealthyAt) return "crit"
		if (p95LatencyMs >= degradedAt) return "warn"
		return "ok"
	}

	if (p95LatencyMs >= P95_UNHEALTHY_MS) return "crit"
	if (p95LatencyMs >= P95_DEGRADED_MS) return "warn"
	return "ok"
}

const SEVERITY_TO_HEALTH: Record<SeverityLevel, ServiceHealth> = {
	ok: "healthy",
	warn: "degraded",
	crit: "unhealthy",
} satisfies Record<SeverityLevel, ServiceHealth>

/** The worse of the error-rate severity and the latency severity. */
export function deriveServiceHealth(signals: ServiceHealthSignals): ServiceHealth {
	return SEVERITY_TO_HEALTH[
		maxSeverity(
			errorRateTone(signals.errorRate),
			latencySeverity(signals.p95LatencyMs, signals.spanCount, signals.baseline),
		)
	]
}

// Worse first — the order the sidebar's Health facet lists, and the order a
// sort on the column would use.
const HEALTH_RANK: Record<ServiceHealth, number> = {
	unhealthy: 2,
	degraded: 1,
	healthy: 0,
} satisfies Record<ServiceHealth, number>

export const healthRank = (health: ServiceHealth): number => HEALTH_RANK[health]

/** Key joining an overview row to its previous-window twin. */
export const serviceRowKey = (serviceName: string, environment: string): string =>
	`${serviceName}::${environment}`

// p95 delta vs the previous window

export interface LatencyDelta {
	/** e.g. `-36% vs 7d`. */
	readonly label: string
	readonly className: string
}

/**
 * The p95 line's second row: how this window compares with the one of the same
 * length before it.
 *
 * Withheld entirely below {@link MIN_BASELINE_SPANS} — a percentage against a
 * handful of spans is a number with no information in it, and a blank cell says
 * that better than a confident-looking `+400%`.
 *
 * The regression ladder is web's (`baselineDelta` in `services-table.tsx`):
 * muted until +25%, warn to +100%, error beyond. The improvement branch is the
 * one addition — web paints a 36% drop in the same muted grey as a 3% drift,
 * and a release that halved p95 is worth as much of the eye as one that doubled
 * it.
 */
export function baselineDelta(
	p95LatencyMs: number,
	baseline: LatencyBaselineSignal | undefined,
	windowLabel: string,
): LatencyDelta | undefined {
	if (baseline === undefined || baseline.spanCount < MIN_BASELINE_SPANS || baseline.p95LatencyMs <= 0) {
		return undefined
	}
	const delta = (p95LatencyMs - baseline.p95LatencyMs) / baseline.p95LatencyMs
	const pct = Math.round(delta * 100)
	// Rounded to nothing is "no change", not "+0%".
	if (pct === 0) return undefined
	return {
		label: `${pct > 0 ? "+" : ""}${pct}% vs ${windowLabel}`,
		className:
			delta >= 1
				? "text-severity-error"
				: delta >= 0.25
					? "text-severity-warn"
					: delta <= -0.05
						? "text-success"
						: "text-muted-foreground",
	}
}

// Environment grouping

const ENVIRONMENT_PRIORITY: Record<string, number> = {
	production: 0,
	staging: 1,
	development: 2,
} satisfies Record<string, number>

/** Rows with no `deployment.environment` at all — rendered as an unlabelled tail group. */
export const NO_ENVIRONMENT = ""

const environmentRank = (environment: string): number =>
	environment === NO_ENVIRONMENT || environment === "unknown"
		? 999
		: (ENVIRONMENT_PRIORITY[environment.toLowerCase()] ?? 3)

/**
 * Group rows by environment, production first and the unlabelled rows last.
 *
 * Same ordering as `groupByEnvironment` in the hosted `services-table.tsx`, and
 * the tail matters more here: a service run from a laptop usually sets no
 * `deployment.environment` at all, so on a local store the unnamed group is
 * frequently the biggest one on the page rather than an edge case.
 */
export function groupByEnvironment<T extends { readonly environment: string }>(
	rows: readonly T[],
): Array<readonly [string, T[]]> {
	const groups = new Map<string, T[]>()
	for (const row of rows) {
		const existing = groups.get(row.environment)
		if (existing) existing.push(row)
		else groups.set(row.environment, [row])
	}
	return [...groups.entries()].sort(([a], [b]) => {
		const rank = environmentRank(a) - environmentRank(b)
		return rank !== 0 ? rank : a.localeCompare(b)
	})
}

export const serviceCountLabel = (count: number): string => `${count} ${count === 1 ? "service" : "services"}`

/** Requests per second, in the hosted table's vocabulary. */
export function formatThroughput(rate: number): string {
	if (rate == null || Number.isNaN(rate) || rate === 0) return "0/s"
	if (rate >= 1000) {
		return `${(rate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k/s`
	}
	if (rate >= 1) return `${rate.toLocaleString(undefined, { maximumFractionDigits: 1 })}/s`
	// A trickle (a few spans an hour) rounds to "0/s", which reads as dead. Say
	// "less than" instead, matching the service map's rate labels.
	if (rate > 0 && rate < 0.0005) return "<0.001/s"
	return `${rate.toLocaleString(undefined, { maximumFractionDigits: 3 })}/s`
}

/**
 * Seconds a range key covers.
 *
 * Not `windowDurationSeconds` over the compiled bounds: `boundsForRange` pads
 * `endTime` an hour into the future to absorb clock skew, and dividing a span
 * count by the padded width would report a 1h window's throughput at half its
 * real rate.
 */
export function rangeDurationSeconds(key: string | undefined): number {
	const range = TIME_RANGES.find((r) => r.key === key) ?? TIME_RANGES[TIME_RANGES.length - 1]
	return range.minutes * 60
}

/** The range's own label, so a delta reads `vs 7d` rather than `vs previous`. */
export function rangeWindowLabel(key: string | undefined): string {
	const range = TIME_RANGES.find((r) => r.key === key) ?? TIME_RANGES[TIME_RANGES.length - 1]
	return range.key
}

// Version ("Last deploy")

export interface ServiceVersionSighting {
	readonly version: string
	readonly firstSeen: string
	readonly lastSeen: string
	readonly spanCount: number
}

/**
 * The version a row's "Last deploy" cell names.
 *
 * The most recently *active* version, not the most recently first-seen one: a
 * rollback re-serves an older release, and the release still taking traffic is
 * what the column means by current. Ties break on volume, so a single straggler
 * pod cannot outrank the version the fleet is actually running.
 */
export function currentVersion(
	sightings: readonly ServiceVersionSighting[],
): ServiceVersionSighting | undefined {
	return sightings.reduce<ServiceVersionSighting | undefined>((best, sighting) => {
		if (best === undefined) return sighting
		if (sighting.lastSeen > best.lastSeen) return sighting
		if (sighting.lastSeen === best.lastSeen && sighting.spanCount > best.spanCount) return sighting
		return best
	}, undefined)
}

// The rendered row, and the filtering over it

/**
 * One (service, environment) row of the table, with every query's contribution
 * already joined onto it.
 *
 * Assembled in `useLocalServiceList` rather than in the view so the sidebar's
 * facet counts and the table's rows are two readings of one array — a health
 * count that disagreed with the badges beside it would be a bug nobody could
 * see in either place alone.
 */
export interface ServiceListRow {
	readonly serviceName: string
	readonly serviceNamespace: string
	readonly environment: string
	readonly p50LatencyMs: number
	readonly p95LatencyMs: number
	readonly p99LatencyMs: number
	readonly errorRate: number
	/** Requests per second, sampling-corrected. */
	readonly throughput: number
	/** Requests per second, stored spans only. */
	readonly tracedThroughput: number
	readonly hasSampling: boolean
	readonly samplingWeight: number
	readonly spanCount: number
	readonly errorCount: number
	readonly health: ServiceHealth
	readonly delta: LatencyDelta | undefined
	/** `service.version` still taking traffic; `""` when the service stamps none. */
	readonly version: string
	/** Window-clamped first sighting of {@link version}; `""` when unknown. */
	readonly versionFirstSeen: string
	/** `vcs.ref.head.revision`; `""` on a build that doesn't stamp it, which is most local ones. */
	readonly commitSha: string
}

export interface ServiceListFilters {
	readonly env?: string | undefined
	readonly ns?: string | undefined
	readonly version?: string | undefined
	readonly health?: ServiceHealth | undefined
	/** Substring match on the service name. */
	readonly search?: string | undefined
}

type FilterDimension = keyof ServiceListFilters

function matchesExcept<R extends ServiceListRow>(
	row: R,
	filters: ServiceListFilters,
	except?: FilterDimension,
): boolean {
	if (except !== "env" && filters.env !== undefined && row.environment !== filters.env) return false
	if (except !== "ns" && filters.ns !== undefined && row.serviceNamespace !== filters.ns) return false
	if (except !== "version" && filters.version !== undefined && row.version !== filters.version) {
		return false
	}
	if (except !== "health" && filters.health !== undefined && row.health !== filters.health) return false
	if (
		except !== "search" &&
		filters.search !== undefined &&
		filters.search !== "" &&
		!row.serviceName.toLowerCase().includes(filters.search.toLowerCase())
	) {
		return false
	}
	return true
}

export function filterServiceRows<R extends ServiceListRow>(
	rows: readonly R[],
	filters: ServiceListFilters,
): R[] {
	return rows.filter((row) => matchesExcept(row, filters))
}

export interface ServiceFacet {
	readonly name: string
	readonly count: number
}

export interface ServiceListFacets {
	/** Always all three levels, in worst-first order, so a count can honestly read 0. */
	readonly health: ServiceFacet[]
	readonly environments: ServiceFacet[]
	readonly namespaces: ServiceFacet[]
	readonly versions: ServiceFacet[]
}

function countFacet<R extends ServiceListRow>(
	rows: readonly R[],
	filters: ServiceListFilters,
	dimension: FilterDimension,
	pick: (row: R) => string,
): ServiceFacet[] {
	const counts = new Map<string, number>()
	for (const row of rows) {
		if (!matchesExcept(row, filters, dimension)) continue
		const value = pick(row)
		// `""` is "attribute absent", not a value anyone can filter on.
		if (value === "") continue
		counts.set(value, (counts.get(value) ?? 0) + 1)
	}
	return [...counts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/**
 * Facet counts for the sidebar.
 *
 * Every facet is counted over the rows the OTHER filters admit, and not over
 * its own — so ticking `production` leaves the Environment section showing what
 * each environment would give you, rather than collapsing every other row to
 * zero and stranding the choice. Health is the same rule applied to a derived
 * column.
 */
export function serviceListFacets<R extends ServiceListRow>(
	rows: readonly R[],
	filters: ServiceListFilters,
): ServiceListFacets {
	const healthCounts = new Map<ServiceHealth, number>(HEALTH_LEVELS.map((level) => [level, 0]))
	for (const row of rows) {
		if (!matchesExcept(row, filters, "health")) continue
		healthCounts.set(row.health, (healthCounts.get(row.health) ?? 0) + 1)
	}

	return {
		health: HEALTH_LEVELS.map((level) => ({ name: level, count: healthCounts.get(level) ?? 0 })),
		environments: countFacet(rows, filters, "env", (row) => row.environment),
		namespaces: countFacet(rows, filters, "ns", (row) => row.serviceNamespace),
		versions: countFacet(rows, filters, "version", (row) => row.version),
	}
}
