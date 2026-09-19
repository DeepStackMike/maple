// Shaping for the Logs page's severity histogram and its severity facet.
//
// Pure. The view hands over the rows `logsTimeseriesQuery({ groupBy:
// ["severity"] })` returned plus the window they were asked for, and gets back
// a dense, draw-ready grid; nothing in here knows about SVG, React or
// ClickHouse. That split is deliberate — the arithmetic that decides which
// bucket a row lands in, and which buckets exist at all, is exactly the part
// worth pinning down in a test, and the part that is wrong in every histogram
// that has ever silently dropped its last bar.

import { getSeverityColor } from "@maple/ui/lib/severity"
import { parseClickHouseDateTime } from "./time"

/**
 * Severity for a log that carries none.
 *
 * `buildLogsGroupNameExpr` coalesces an empty `SeverityText` to the literal
 * `"all"` — it is the same sentinel it emits for a query with no group-by at
 * all, so a `groupBy: ["severity"]` result carrying `"all"` means "no severity
 * on the record" and nothing else. Naming it here keeps that one piece of
 * query-engine trivia out of the view.
 */
export const UNSET_SEVERITY = "UNSET"

/**
 * One severity, spelled one way.
 *
 * SDKs disagree on case — an org ships `INFO`, `Info` and `info` side by side —
 * and they are one severity to the reader. Folding them here is what keeps the
 * stack from growing three identical-looking bands and the facet three
 * identical-looking rows.
 */
export function canonicalSeverity(groupName: string): string {
	const trimmed = groupName.trim()
	if (trimmed === "" || trimmed === "all") return UNSET_SEVERITY
	return trimmed.toUpperCase()
}

/**
 * Reading order for severities, lowest number first.
 *
 * Not ClickHouse's `SeverityNumber` order and not alphabetical: it is the order
 * the eye scans a log level list in, INFO first because it is the baseline
 * everything else is a deviation from. `WARNING` shares `WARN`'s rank because
 * it is the same level under the OTel alias, and a tie is broken by traffic so
 * the two never interleave with anything between them. Anything unranked —
 * `FATAL`, a vendor level, an unset severity — sorts after, by traffic.
 */
const SEVERITY_RANK = new Map<string, number>([
	["INFO", 0],
	["WARN", 1],
	["WARNING", 1],
	["ERROR", 2],
	["DEBUG", 3],
	["TRACE", 4],
])

const UNRANKED = Number.MAX_SAFE_INTEGER

export function severityRank(name: string): number {
	return SEVERITY_RANK.get(canonicalSeverity(name)) ?? UNRANKED
}

/**
 * Sorts facet options — and the histogram's stacking order — into reading
 * order. One comparator for both, so a band's position in the stack is the
 * position of its row in the sidebar.
 */
export function orderBySeverity<T extends { readonly name: string; readonly count: number }>(
	options: ReadonlyArray<T>,
): T[] {
	return [...options].sort(
		(a, b) =>
			severityRank(a.name) - severityRank(b.name) || b.count - a.count || a.name.localeCompare(b.name),
	)
}

/**
 * Option name → swatch colour, for `FilterSection`'s `colorMap`.
 *
 * Keyed by the name as the data spells it (`Info`), not the canonical one:
 * `colorMap` is looked up by exact option name, so a map keyed `INFO` would
 * leave a lowercase facet row with no swatch beside a coloured band in the
 * chart above it. `getSeverityColor` folds the case on the way in.
 */
export function severityColorMap(names: Iterable<string>): Record<string, string> {
	const map: Record<string, string> = {}
	for (const name of names) map[name] = getSeverityColor(name)
	return map
}

/** One `(bucket, severity)` cell as the timeseries query returns it. */
export interface LogSeriesRow {
	readonly bucket: string
	readonly groupName: string
	readonly count: number
}

export interface LogHistogramBucket {
	readonly startMs: number
	/** Exclusive. `startMs + bucketSeconds * 1000`. */
	readonly endMs: number
	readonly total: number
	/** Counts by canonical severity. Levels with nothing in this bucket are absent. */
	readonly counts: Readonly<Record<string, number>>
}

export interface LogHistogram {
	/** Dense: one entry per bucket in the window, zeroes included. */
	readonly buckets: ReadonlyArray<LogHistogramBucket>
	/** Canonical severities present anywhere in the window, in {@link orderBySeverity} order. */
	readonly levels: ReadonlyArray<string>
	readonly bucketSeconds: number
	/** Every log the window holds, under the filters that produced `rows`. */
	readonly total: number
	/** The tallest column, which is what the y axis has to reach. */
	readonly maxTotal: number
}

export const EMPTY_LOG_HISTOGRAM: LogHistogram = {
	buckets: [],
	levels: [],
	bucketSeconds: 0,
	total: 0,
	maxTotal: 0,
}

/**
 * Past this the grid is not a histogram, it is a request to lay out thousands
 * of rects a pixel wide. A guard, not a policy: the caller picks the bucket
 * width off the range, and every width it can pick lands two orders of
 * magnitude below this.
 */
const MAX_BUCKETS = 2000

export interface LogHistogramWindow {
	readonly startMs: number
	readonly endMs: number
	readonly bucketSeconds: number
}

/**
 * Fold `(bucket, severity, count)` rows into the dense grid the chart draws.
 *
 * **The grid is anchored to the epoch, not to the window.** `toStartOfInterval`
 * floors a timestamp to a multiple of the interval counted from 1970, so the
 * first bucket of a 5-minute grid over a window starting at 10:32 is 10:30 —
 * building the grid from the window's own start instead would put every row
 * half a bucket away from the slot it was meant for, which reads as a chart
 * that is subtly, unfixably off by a bar.
 *
 * **Trailing empty buckets are dropped.** `boundsForRange` pads its upper bound
 * an hour into the future to absorb clock skew between the browser and whatever
 * wrote the logs, so an honest rendering of the requested window always ends in
 * an hour of guaranteed-empty bars. They are not a quiet period and drawing
 * them as one is a lie about the data; worse, they push the actual traffic off
 * the right-hand edge where the reader looks first. Leading empties stay: those
 * are the window genuinely reaching back before anything was ingested, which is
 * worth seeing.
 */
export function buildLogHistogram(
	rows: ReadonlyArray<LogSeriesRow>,
	{ startMs, endMs, bucketSeconds }: LogHistogramWindow,
): LogHistogram {
	if (!Number.isFinite(bucketSeconds) || bucketSeconds <= 0) return EMPTY_LOG_HISTOGRAM
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return EMPTY_LOG_HISTOGRAM

	const bucketMs = bucketSeconds * 1000
	const gridStart = Math.floor(startMs / bucketMs) * bucketMs
	const gridEnd = Math.floor(endMs / bucketMs) * bucketMs
	const count = Math.floor((gridEnd - gridStart) / bucketMs) + 1
	if (count > MAX_BUCKETS) return EMPTY_LOG_HISTOGRAM

	const cells: Array<Record<string, number>> = Array.from({ length: count }, () => ({}))
	const levelTotals = new Map<string, number>()
	let total = 0

	for (const row of rows) {
		const bucketMsValue = parseClickHouseDateTime(row.bucket)
		if (bucketMsValue === null) continue
		const index = Math.floor((bucketMsValue - gridStart) / bucketMs)
		// A row outside the grid is a bucket the query returned for a window the
		// caller is no longer asking about (a refetch that raced a range change).
		// Counting it would put traffic in the total that has no column to sit in.
		if (index < 0 || index >= count) continue

		const value = Number(row.count)
		if (!Number.isFinite(value) || value <= 0) continue

		const level = canonicalSeverity(row.groupName)
		cells[index][level] = (cells[index][level] ?? 0) + value
		levelTotals.set(level, (levelTotals.get(level) ?? 0) + value)
		total += value
	}

	let lastNonEmpty = -1
	for (let index = count - 1; index >= 0; index--) {
		if (Object.keys(cells[index]).length > 0) {
			lastNonEmpty = index
			break
		}
	}
	if (lastNonEmpty < 0) return EMPTY_LOG_HISTOGRAM

	const buckets: LogHistogramBucket[] = []
	let maxTotal = 0
	for (let index = 0; index <= lastNonEmpty; index++) {
		const counts = cells[index]
		let bucketTotal = 0
		for (const value of Object.values(counts)) bucketTotal += value
		if (bucketTotal > maxTotal) maxTotal = bucketTotal
		const bucketStart = gridStart + index * bucketMs
		buckets.push({ startMs: bucketStart, endMs: bucketStart + bucketMs, total: bucketTotal, counts })
	}

	const levels = orderBySeverity(
		[...levelTotals].map(([name, levelTotal]) => ({ name, count: levelTotal })),
	).map((entry) => entry.name)

	return { buckets, levels, bucketSeconds, total, maxTotal }
}

/**
 * A round number at or above `value`, for the top of the count axis.
 *
 * The 1/2/5 ladder rather than `Math.pow(10, ceil(log10))`, which turns a peak
 * of 110 into an axis of 1000 and flattens every bar in the chart to a tenth of
 * its height.
 */
export function niceCeiling(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 1
	const magnitude = 10 ** Math.floor(Math.log10(value))
	for (const step of [1, 2, 5, 10]) {
		const candidate = step * magnitude
		if (value <= candidate) return candidate
	}
	return 10 * magnitude
}

/**
 * Column indices to label along a histogram's time axis, first and last always
 * among them.
 *
 * Whole columns rather than evenly-spaced pixels: every label then sits under a
 * bar that exists and reads the time that bar covers, instead of naming an
 * instant between two of them.
 */
export function pickTickIndices(count: number, target: number): number[] {
	if (count <= 0 || target <= 0) return []
	if (target === 1) return [0]
	if (count <= target) return Array.from({ length: count }, (_, index) => index)
	const step = (count - 1) / (target - 1)
	const indices = new Set<number>()
	for (let tick = 0; tick < target; tick++) indices.add(Math.round(tick * step))
	return [...indices].sort((a, b) => a - b)
}
