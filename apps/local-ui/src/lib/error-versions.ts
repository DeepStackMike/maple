// Reading a fingerprint's per-build occurrence split, and comparing each build
// against the one it replaced.
//
// The rule is the hosted release model's (#1087): a version is compared against
// its predecessor on the same service and environment, over that predecessor's
// own lifetime in the window, not against every other version merged. A store
// that deploys every save has dozens of versions in a day; a merged baseline
// mixes all of them and nothing ever reads as new.
//
// Two inputs, because neither alone can answer the question:
// - error slices: this fingerprint's count per (service, environment, version)
// - version traffic: every version's span count and first/last span per
//   (service, environment), which is what orders versions and supplies the
//   denominator. A version on which the error never fired has no error slice,
//   and it is exactly the baseline that proves an error new.

/** One `(fingerprint, version)` group, as `CH.ErrorVersionsOutput` gives it. */
export interface VersionRow {
	readonly serviceVersion: string
	readonly count: number
	readonly firstSeen: string
	readonly lastSeen: string
}

/** This fingerprint's occurrences on one version of one (service, environment). */
export interface ErrorSlice extends VersionRow {
	readonly serviceName: string
	readonly environment: string
}

/** One version's traffic on one (service, environment) inside the window. */
export interface VersionTraffic {
	readonly serviceName: string
	readonly environment: string
	readonly version: string
	readonly spanCount: number
	/** Earliest span carrying this version, clamped to the window's start. */
	readonly firstSeen: string
	readonly lastSeen: string
}

/** Below this many spans on either side, a rate is noise and nothing is compared. */
export const MIN_COMPARE_SPANS = 50
/** "More often" means at least twice the predecessor's rate… */
const ERROR_RATIO_THRESHOLD = 2
/** …by a margin that cannot be rounding (errors per span). */
const ERROR_RATE_MIN_DIFF = 0.005

/** Why a version was not compared. Every one of them is said in the UI. */
export type NotComparedReason =
	/** The exporter set no `service.version`. */
	| "unversioned"
	/** No span traffic recorded for this version (e.g. only non-entry spans carried it). */
	| "no-traffic"
	/** No version on this service + environment was first seen strictly earlier in the window. */
	| "oldest"
	/** This version or its predecessor carried fewer than {@link MIN_COMPARE_SPANS} spans. */
	| "low-traffic"

/** How this version's error rate reads against its predecessor's. */
export type ComparisonVerdict = "new" | "more" | "fewer" | "similar"

export interface VersionBaseline {
	readonly version: string
	readonly firstSeen: string
	readonly spanCount: number
	/** This fingerprint's occurrences on the predecessor (0 when it never fired there). */
	readonly errorCount: number
	readonly errorRate: number
}

export type VersionComparison =
	| {
			readonly kind: "compared"
			readonly baseline: VersionBaseline
			readonly errorRate: number
			/** `errorRate / baseline.errorRate`; `null` when the predecessor never had this error. */
			readonly ratio: number | null
			readonly verdict: ComparisonVerdict
	  }
	| {
			readonly kind: "not-compared"
			readonly reason: NotComparedReason
			/** The predecessor, when one exists (the `low-traffic` case). */
			readonly baselineVersion?: string
	  }

export interface ComparedVersion extends ErrorSlice {
	readonly comparison: VersionComparison
}

/**
 * Seconds precision. Versions first seen in the same second have no known
 * order — the warehouse's sub-second digits say which span landed first, not
 * which build was deployed first — so neither may be the other's baseline.
 */
const toSecond = (dateTime: string): string => dateTime.replace("T", " ").slice(0, 19)

const pairKey = (serviceName: string, environment: string) => `${serviceName}\u0000${environment}`

const rate = (count: number, spans: number) => (spans > 0 ? count / spans : 0)

/**
 * The version `version` replaced on its (service, environment): the latest one
 * first seen *strictly* earlier, at second precision. `undefined` for the
 * oldest version in the window — including every version that predates the
 * window, whose clamped first-seen is the window's start.
 */
export function predecessorOf(
	version: VersionTraffic,
	traffic: ReadonlyArray<VersionTraffic>,
): VersionTraffic | undefined {
	const at = toSecond(version.firstSeen)
	let previous: VersionTraffic | undefined
	for (const candidate of traffic) {
		if (candidate.serviceName !== version.serviceName || candidate.environment !== version.environment)
			continue
		const seen = toSecond(candidate.firstSeen)
		if (seen >= at) continue
		if (!previous || seen > toSecond(previous.firstSeen)) previous = candidate
	}
	return previous
}

/** Compare every error slice against its version's predecessor. Input order is kept. */
export function compareErrorVersions(
	slices: ReadonlyArray<ErrorSlice>,
	traffic: ReadonlyArray<VersionTraffic>,
): Array<ComparedVersion> {
	const trafficByKey = new Map<string, VersionTraffic>()
	for (const row of traffic)
		trafficByKey.set(`${pairKey(row.serviceName, row.environment)}\u0000${row.version}`, row)
	const sliceByKey = new Map<string, ErrorSlice>()
	for (const slice of slices)
		sliceByKey.set(`${pairKey(slice.serviceName, slice.environment)}\u0000${slice.serviceVersion}`, slice)

	return slices.map((slice): ComparedVersion => {
		const notCompared = (reason: NotComparedReason, baselineVersion?: string): ComparedVersion => ({
			...slice,
			comparison: { kind: "not-compared", reason, baselineVersion },
		})
		if (!slice.serviceVersion) return notCompared("unversioned")

		const key = pairKey(slice.serviceName, slice.environment)
		const own = trafficByKey.get(`${key}\u0000${slice.serviceVersion}`)
		if (!own || own.spanCount <= 0) return notCompared("no-traffic")

		const previous = predecessorOf(own, traffic)
		if (!previous) return notCompared("oldest")
		if (own.spanCount < MIN_COMPARE_SPANS || previous.spanCount < MIN_COMPARE_SPANS)
			return notCompared("low-traffic", previous.version)

		const baselineErrors = sliceByKey.get(`${key}\u0000${previous.version}`)?.count ?? 0
		const baseline: VersionBaseline = {
			version: previous.version,
			firstSeen: previous.firstSeen,
			spanCount: previous.spanCount,
			errorCount: baselineErrors,
			errorRate: rate(baselineErrors, previous.spanCount),
		}
		const errorRate = rate(slice.count, own.spanCount)
		const ratio = baseline.errorRate > 0 ? errorRate / baseline.errorRate : null
		const diff = errorRate - baseline.errorRate
		const verdict: ComparisonVerdict =
			ratio === null
				? "new"
				: ratio >= ERROR_RATIO_THRESHOLD && diff >= ERROR_RATE_MIN_DIFF
					? "more"
					: ratio <= 1 / ERROR_RATIO_THRESHOLD && -diff >= ERROR_RATE_MIN_DIFF
						? "fewer"
						: "similar"
		return { ...slice, comparison: { kind: "compared", baseline, errorRate, ratio, verdict } }
	})
}

export type Introduction =
	/** Fired on `version` and not on the version it replaced, which had the traffic to show it. */
	| { readonly kind: "introduced"; readonly version: string; readonly baselineVersion: string }
	/** Earliest version it fired on, but nothing could be compared — `reason` says why. */
	| {
			readonly kind: "first-seen"
			readonly version: string
			readonly reason: NotComparedReason | "present-before"
			readonly baselineVersion?: string
	  }

/**
 * The build this error arrived on, and whether that is a claim or only an
 * observation.
 *
 * Per (service, environment), the oldest version — by the version's own first
 * span, not the error's — on which the error fired. It is "introduced" there
 * only when that version has a predecessor with enough traffic and the error
 * never fired on it. The oldest version in the window has nothing before it, so
 * it is reported as first-seen with the reason, never as introduced: the window
 * is a window, and a one-hour range says nothing about last week.
 *
 * Across several (service, environment) pairs the earliest such version wins;
 * an introduction beats a bare first-seen at the same instant. `null` when no
 * slice carries a version.
 */
export function introducedIn(
	compared: ReadonlyArray<ComparedVersion>,
	traffic: ReadonlyArray<VersionTraffic>,
): Introduction | null {
	const firstSeenOf = (row: ComparedVersion) =>
		toSecond(
			traffic.find(
				(t) =>
					t.serviceName === row.serviceName &&
					t.environment === row.environment &&
					t.version === row.serviceVersion,
			)?.firstSeen ?? row.firstSeen,
		)

	const oldestPerPair = new Map<string, ComparedVersion>()
	for (const row of compared) {
		if (!row.serviceVersion) continue
		const key = pairKey(row.serviceName, row.environment)
		const current = oldestPerPair.get(key)
		if (!current || firstSeenOf(row) < firstSeenOf(current)) oldestPerPair.set(key, row)
	}

	let best: { at: string; introduction: Introduction } | undefined
	for (const row of oldestPerPair.values()) {
		const introduction = toIntroduction(row)
		const at = firstSeenOf(row)
		if (
			!best ||
			at < best.at ||
			(at === best.at && introduction.kind === "introduced" && best.introduction.kind !== "introduced")
		)
			best = { at, introduction }
	}
	return best?.introduction ?? null
}

function toIntroduction(row: ComparedVersion): Introduction {
	const { comparison } = row
	if (comparison.kind === "not-compared")
		return {
			kind: "first-seen",
			version: row.serviceVersion,
			reason: comparison.reason,
			baselineVersion: comparison.baselineVersion,
		}
	if (comparison.verdict === "new")
		return {
			kind: "introduced",
			version: row.serviceVersion,
			baselineVersion: comparison.baseline.version,
		}
	// Only reachable when the predecessor's own slice was missed (e.g. a
	// truncated result): the error was there before, so this is not its origin.
	return {
		kind: "first-seen",
		version: row.serviceVersion,
		reason: "present-before",
		baselineVersion: comparison.baseline.version,
	}
}

/** True when not a single row of the table could be compared — the UI says so instead of leaving blanks. */
export function nothingCompared(compared: ReadonlyArray<ComparedVersion>): boolean {
	return compared.every((row) => row.comparison.kind === "not-compared")
}

/**
 * Versions for display: most recently active first.
 *
 * Ties break on count, then on version string, so two builds whose last
 * occurrence landed in the same second do not swap places between renders —
 * `Array#sort` is stable but the input order is a SQL `ORDER BY` over values
 * that change as data arrives.
 */
export function versionsByRecency<T extends VersionRow>(rows: ReadonlyArray<T>): Array<T> {
	return [...rows].sort(
		(a, b) =>
			b.lastSeen.localeCompare(a.lastSeen) ||
			b.count - a.count ||
			a.serviceVersion.localeCompare(b.serviceVersion),
	)
}
