// Turning `errorsSparkQuery`'s tall result into one row's worth of sparkline.
//
// The query returns (fingerprint, bucket, count) for every fingerprint the page
// is about to draw, in one scan. Everything between that and a `<StatSparkline>`
// is arithmetic with two traps in it — bucket sizing and the holes — so it
// lives here where a test can hold it.

import { TIME_RANGES } from "./time"

/** One `(bucket, count)` group, as `CH.ErrorsSparkOutput` gives it. */
export interface SparkPoint {
	readonly bucket: string
	readonly count: number
}

/**
 * Bucket widths a human recognises on an axis: minutes, quarter-hours, hours,
 * quarter-days, days. A computed `windowSeconds / 40` is none of those — it
 * produces 2160-second buckets whose boundaries fall at 12:36 and 13:12, and
 * `toStartOfInterval` aligns to the epoch, so those boundaries are stable and
 * meaningless rather than unstable and meaningless.
 */
const BUCKET_LADDER = [60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400] as const

/** Points to aim for across the range. Wide enough to show a shape, narrow enough to stay legible at 96px. */
const TARGET_BUCKETS = 40

export interface SparkWindow {
	readonly startMs: number
	readonly endMs: number
	readonly bucketSeconds: number
}

/**
 * The window a row's sparkline covers, and how finely to cut it.
 *
 * Deliberately NOT `boundsForRange`'s window: that one pads its upper bound an
 * hour into the future to absorb clock skew between an exporter and this
 * process, which is right for a `WHERE` clause and wrong for an axis — it would
 * draw every error trailing off into an hour of zeroes it has no data for. The
 * query still runs over the padded bounds; only the drawing stops at now.
 */
export function sparkWindow(range: string | undefined, anchorMs = Date.now()): SparkWindow {
	const preset = TIME_RANGES.find((r) => r.key === range) ?? TIME_RANGES[TIME_RANGES.length - 1]
	const windowSeconds = preset.minutes * 60
	const ideal = windowSeconds / TARGET_BUCKETS
	const bucketSeconds = BUCKET_LADDER.find((step) => step >= ideal) ?? BUCKET_LADDER.at(-1)!
	return { startMs: anchorMs - windowSeconds * 1000, endMs: anchorMs, bucketSeconds }
}

/**
 * Group the flat result by fingerprint, preserving the SQL's bucket order.
 *
 * A Map so a row looks its own series up by hash on render instead of filtering
 * the whole result once per row — at fifty rows and forty buckets that is the
 * difference between one pass and two thousand.
 */
export function groupSparkPoints<T extends SparkPoint & { readonly fingerprintHash: string }>(
	rows: ReadonlyArray<T>,
): Map<string, Array<SparkPoint>> {
	const byFingerprint = new Map<string, Array<SparkPoint>>()
	for (const row of rows) {
		const point = { bucket: row.bucket, count: row.count }
		const list = byFingerprint.get(row.fingerprintHash)
		if (list) list.push(point)
		else byFingerprint.set(row.fingerprintHash, [point])
	}
	return byFingerprint
}

/**
 * A count for every bucket in the window, including the empty ones.
 *
 * The query only returns buckets that had an occurrence, and a sparkline plots
 * a sequence with no time axis — so plotting the returned rows directly draws a
 * flat line for an error that fired twice a week apart, and an identical flat
 * line for one firing steadily. The zeroes are the signal.
 *
 * Buckets are keyed by `floor(t / bucketSeconds)`, which is what ClickHouse's
 * `toStartOfInterval` does for a seconds interval (it aligns to the epoch, not
 * to the window's start) — so a returned bucket always lands on a slot here.
 */
export function denseCounts(points: ReadonlyArray<SparkPoint>, window: SparkWindow): Array<number> {
	const { startMs, endMs, bucketSeconds } = window
	const bucketMs = bucketSeconds * 1000
	const firstSlot = Math.floor(startMs / bucketMs)
	const lastSlot = Math.floor(endMs / bucketMs)
	const slots: Array<number> = Array.from({ length: Math.max(lastSlot - firstSlot + 1, 0) }, () => 0)

	for (const point of points) {
		const ms = parseBucket(point.bucket)
		if (ms === null) continue
		const index = Math.floor(ms / bucketMs) - firstSlot
		// Occurrences outside the drawn window are dropped rather than clamped to
		// its edges: the query's upper bound is padded for clock skew, and a
		// skewed exporter's row piled onto the last slot would read as a spike.
		if (index < 0 || index >= slots.length) continue
		slots[index] += point.count
	}
	return slots
}

/**
 * Parse a chDB UTC datetime (`'YYYY-MM-DD HH:MM:SS'`, no zone marker) to
 * epoch-ms. Local's `parseClickHouseDateTime` is the same parse; it is repeated
 * here rather than imported so this module stays a pure function of its inputs
 * and can be tested without the time module's presets moving under it.
 */
function parseBucket(bucket: string): number | null {
	const ms = Date.parse(`${bucket.replace(" ", "T")}Z`)
	return Number.isNaN(ms) || ms <= 0 ? null : ms
}
