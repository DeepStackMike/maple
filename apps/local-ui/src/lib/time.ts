// Time helpers for the local query layer.
//
// The CH query builders accept `startTime` / `endTime` as ClickHouse DateTime
// strings (`'YYYY-MM-DD HH:MM:SS'`); `resolveParam` quotes them inline. chDB
// parses the quoted string into a DateTime for the partition-pruning filters.

import { formatRelativeFrom } from "@maple/ui/lib/time-format"

import { formatWarehouseDateTime } from "@maple/query-engine"
/** Format an epoch-ms instant as a ClickHouse DateTime string (UTC, second precision). */
export function toClickHouseDateTime(epochMs: number): string {
	return formatWarehouseDateTime(epochMs)
}

export interface TimeBounds {
	startTime: string
	endTime: string
}

// Time-range presets — drive the segmented range control in the filter bar.

export interface TimeRange {
	readonly key: string
	readonly label: string
	readonly minutes: number
}

export const TIME_RANGES: ReadonlyArray<TimeRange> = [
	{ key: "1h", label: "1H", minutes: 60 },
	{ key: "6h", label: "6H", minutes: 6 * 60 },
	{ key: "24h", label: "24H", minutes: 24 * 60 },
	{ key: "7d", label: "7D", minutes: 7 * 24 * 60 },
	{ key: "30d", label: "30D", minutes: 30 * 24 * 60 },
]

/** Default look-back. Mirrors the original 30-day window so behavior is unchanged until a user narrows it. */
export const DEFAULT_RANGE = "30d"

/**
 * Home's default look-back, deliberately narrower than {@link DEFAULT_RANGE}.
 *
 * The list views default wide because their job is "find the thing", and a
 * filtered list of nothing is a dead end. Home's job is "what is happening
 * now", and a 30-day window answers it with a month-long average — a service
 * that has been down all afternoon still reads healthy. Home writes the
 * resolved range onto every link it emits, so following one lands the target
 * tab on the same window rather than on its own default.
 */
export const HOME_DEFAULT_RANGE = "24h"

// Custom (absolute) ranges.
//
// A preset key names a window relative to "now"; a custom key *is* the window.
// Both travel in the same `range` search param — `range=custom_1758186000_1758243000`
// — because every view, hook and link in this app already threads one opaque
// range string, and splitting the window across a second and third param would
// mean touching all of them to gain nothing a self-describing key does not
// already give. Seconds, not milliseconds: the picker is minute-resolution, and
// `URLSearchParams` leaves `_` and digits unescaped, so the hash stays readable
// and shareable.

const CUSTOM_PREFIX = "custom_"

/** The select's "open the picker" sentinel. Never stored — a chosen window replaces it. */
export const CUSTOM_RANGE_OPTION = "custom"

/**
 * Widest window the picker will accept.
 *
 * The local store keeps raw spans and logs 30 days and the hourly rollups 90
 * (see `apps/cli/src/server/schema/local-schema-v13.sql`), so 90 days is the
 * most any view can still answer. Past it a window is not "wide", it is a scan
 * of empty partitions.
 */
export const MAX_CUSTOM_RANGE_MS = 90 * 24 * 60 * 60 * 1000

/** An explicit window, as epoch-ms instants. */
export interface AbsoluteRange {
	readonly fromMs: number
	readonly toMs: number
}

/** Encode an absolute window as a range key. Truncates to whole seconds. */
export function customRangeKey({ fromMs, toMs }: AbsoluteRange): string {
	return `${CUSTOM_PREFIX}${Math.floor(fromMs / 1000)}_${Math.floor(toMs / 1000)}`
}

/**
 * Decode a range key into its window, or `null` if it is a preset key or
 * malformed. Validation lives here rather than at the call sites: a key comes
 * off the URL, where anyone can type one, and every consumer resolves it
 * through {@link resolveRange}, which falls back to a preset on `null`.
 */
export function parseCustomRange(key: string | undefined): AbsoluteRange | null {
	if (!key || !key.startsWith(CUSTOM_PREFIX)) return null
	const [rawFrom, rawTo, ...rest] = key.slice(CUSTOM_PREFIX.length).split("_")
	if (rest.length > 0 || !rawFrom || !rawTo) return null
	if (!/^\d+$/.test(rawFrom) || !/^\d+$/.test(rawTo)) return null
	const fromMs = Number(rawFrom) * 1000
	const toMs = Number(rawTo) * 1000
	if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs)) return null
	if (toMs <= fromMs || toMs - fromMs > MAX_CUSTOM_RANGE_MS) return null
	return { fromMs, toMs }
}

/** Why this window can't be used, or `null` when it can. Drives the picker's inline error. */
export function customRangeError(range: Partial<AbsoluteRange>, nowMs = Date.now()): string | null {
	const { fromMs, toMs } = range
	if (fromMs == null || toMs == null || Number.isNaN(fromMs) || Number.isNaN(toMs)) {
		return "Pick both a start and an end."
	}
	if (toMs <= fromMs) return "The end must be after the start."
	// A window may end slightly ahead of now — an exporter's clock can run ahead,
	// and "up to now" rounded to the next minute is a normal thing to ask for.
	if (fromMs > nowMs + CLOCK_SKEW_PAD_MS) return "The start is in the future."
	if (toMs - fromMs > MAX_CUSTOM_RANGE_MS) return "Windows are limited to 90 days."
	return null
}

/** The hour of slack every window allows for an exporter whose clock runs ahead. */
const CLOCK_SKEW_PAD_MS = 60 * 60 * 1000

/**
 * A range key resolved to instants, whatever kind of key it was.
 *
 * `startMs`/`endMs` are the window the user asked for — *not* the padded bounds
 * the `WHERE` clause uses. Anything drawing an axis or dividing by a duration
 * wants these; only {@link boundsForRange} wants the padding.
 */
export interface ResolvedRange {
	readonly startMs: number
	readonly endMs: number
	/** Window length in seconds. What bucket/step sizing divides. */
	readonly seconds: number
	/** True when the key carried explicit bounds rather than a look-back. */
	readonly absolute: boolean
	/** Full label, e.g. `24H` or `Sep 18, 09:00 → Sep 19, 17:30`. */
	readonly label: string
	/**
	 * Duration-only label for places with no room for two timestamps — a canvas
	 * header, a "vs previous X" stat. `24H` for a preset, `36H` for a custom
	 * window of the same shape.
	 */
	readonly shortLabel: string
}

/**
 * Resolve any range key — preset or custom — to a window.
 *
 * An unknown or malformed key falls back to the widest preset, which is the
 * behaviour every previous `TIME_RANGES.find(...) ?? last` site had.
 */
export function resolveRange(key: string | undefined, anchorMs = Date.now()): ResolvedRange {
	const custom = parseCustomRange(key)
	if (custom) {
		return {
			startMs: custom.fromMs,
			endMs: custom.toMs,
			seconds: Math.round((custom.toMs - custom.fromMs) / 1000),
			absolute: true,
			label: formatAbsoluteRange(custom),
			shortLabel: formatDurationLabel((custom.toMs - custom.fromMs) / 1000),
		}
	}
	const preset = TIME_RANGES.find((r) => r.key === key) ?? TIME_RANGES[TIME_RANGES.length - 1]
	return {
		startMs: anchorMs - preset.minutes * 60 * 1000,
		endMs: anchorMs,
		seconds: preset.minutes * 60,
		absolute: false,
		label: preset.key.toUpperCase(),
		shortLabel: preset.key.toUpperCase(),
	}
}

/**
 * Resolve a range key to ClickHouse DateTime bounds.
 *
 * A preset's upper bound is padded an hour ahead so rows from an exporter whose
 * clock runs ahead still land inside the window. A custom window is *not*
 * padded: the user named both ends, and quietly returning an hour they did not
 * ask for would make "did anything happen before the deploy at 14:00" unanswerable.
 */
export function boundsForRange(key: string | undefined, anchorMs = Date.now()): TimeBounds {
	const range = resolveRange(key, anchorMs)
	return {
		startTime: toClickHouseDateTime(range.startMs),
		endTime: toClickHouseDateTime(range.absolute ? range.endMs : range.endMs + CLOCK_SKEW_PAD_MS),
	}
}

/**
 * A span of seconds as the coarsest unit that still reads whole-ish: `45M`,
 * `36H`, `9D`. Matches the preset keys' shape (`1h` → `1H`) so a custom window
 * an hour long labels itself the same as the `1h` preset does.
 */
export function formatDurationLabel(seconds: number): string {
	const minutes = Math.max(1, Math.round(seconds / 60))
	// Ragged spans under four hours keep their minutes — "150M" is a window
	// someone chose, "3H" is a lie about it.
	if (minutes < 60 || (minutes % 60 !== 0 && minutes < 240)) return `${minutes}M`
	const hours = Math.round(minutes / 60)
	if (hours < 48) return `${hours}H`
	return `${Math.round(hours / 24)}D`
}

/** Window length in seconds for any range key — what bucket ladders divide. */
export function rangeWindowSeconds(key: string | undefined): number {
	return resolveRange(key).seconds
}

const ABSOLUTE_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
const ABSOLUTE_DAY_YEAR = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
})
const ABSOLUTE_CLOCK = new Intl.DateTimeFormat(undefined, {
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
})

/**
 * Human label for an absolute window, in the reader's own timezone — the same
 * clock the picker's inputs use, so the label reads back what was typed.
 * A window inside one day names that day once.
 */
export function formatAbsoluteRange(range: AbsoluteRange, nowMs = Date.now()): string {
	const from = new Date(range.fromMs)
	const to = new Date(range.toMs)
	const withYear = from.getFullYear() !== new Date(nowMs).getFullYear()
	const day = withYear ? ABSOLUTE_DAY_YEAR : ABSOLUTE_DAY
	const sameDay = from.toDateString() === to.toDateString()
	const start = `${day.format(from)}, ${ABSOLUTE_CLOCK.format(from)}`
	const end = sameDay ? ABSOLUTE_CLOCK.format(to) : `${day.format(to)}, ${ABSOLUTE_CLOCK.format(to)}`
	return `${start} \u2192 ${end}`
}

/** Epoch-ms as a `<input type="datetime-local">` value (local clock, minute resolution). */
export function toDateTimeLocalInput(epochMs: number): string {
	const d = new Date(epochMs)
	const pad = (n: number) => String(n).padStart(2, "0")
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Parse a `<input type="datetime-local">` value as local-clock epoch-ms. `null` when empty/invalid. */
export function fromDateTimeLocalInput(value: string): number | null {
	if (!value) return null
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
	if (!match) return null
	const [, y, mo, d, h, mi, sec] = match
	const ms = new Date(
		Number(y),
		Number(mo) - 1,
		Number(d),
		Number(h),
		Number(mi),
		Number(sec ?? 0),
	).getTime()
	return Number.isNaN(ms) ? null : ms
}

/**
 * Parse a chDB UTC datetime string (`'YYYY-MM-DD HH:MM:SS'`, no timezone
 * marker) to epoch-ms. Returns `null` for empty/invalid input or the zero date
 * chDB emits for an empty aggregate.
 */
export function parseClickHouseDateTime(chDateTime: string | null | undefined): number | null {
	if (!chDateTime) return null
	const ms = Date.parse(`${chDateTime.replace(" ", "T")}Z`)
	if (Number.isNaN(ms) || ms <= 0) return null
	return ms
}

/**
 * Compact relative-time label from a ClickHouse DateTime string. Keeps the
 * chDB null/zero-date guard, then defers to the shared relative-time ladder.
 */
export function formatRelativeTime(chDateTime: string | null | undefined): string {
	const ms = parseClickHouseDateTime(chDateTime)
	return ms === null ? "—" : formatRelativeFrom(ms)
}
