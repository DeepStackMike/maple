// A log's identity in a URL, and the logs around it.
//
// Pure: the Logs page turns a selected log into a `log=` token (the open
// drawer, and the copyable permalink), resolves a token back into a lookup,
// and builds the two half-windows the "Surrounding logs" panel reads. Ported
// from the hosted app's `lib/log-key.ts` and `log-context-panel.tsx`, minus
// the TanStack route: local is hash-routed, so a permalink is
// `#/logs?log=<token>&range=<window around it>`.

import { Option } from "effect"
import { trySync } from "@maple/ui/lib/try-sync"
import type { LocalLog } from "./log-shape"
import { hrefFor } from "./router"
import { customRangeKey, parseClickHouseDateTime, type TimeBounds } from "./time"

/** The query param carrying the open log. */
export const LOG_PARAM = "log"

/** Logs shown on each side of the selected one. */
export const CONTEXT_SIZE = 25
/** Each side's scan stops this far from the selected log, so a quiet service stays bounded. */
export const CONTEXT_WINDOW_MS = 60 * 60 * 1000
/** How much of the stream a permalink opens around its log, each side. */
export const PERMALINK_WINDOW_MS = 15 * 60 * 1000
/** Resource attributes that name one running instance, most specific first. */
export const INSTANCE_KEYS = ["k8s.pod.name", "service.instance.id", "host.name"] as const

/** The composite identity a token carries: enough to find exactly one stored row. */
export interface LogKey {
	/** The stored `DateTime64(9)` literal, nanoseconds kept. */
	readonly timestamp: string
	readonly serviceName: string
	readonly traceId: string
	readonly spanId: string
	readonly recordIdentity: string
}

function toBase64Url(text: string): string {
	let binary = ""
	for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(token: string): string {
	const binary = atob(token.replace(/-/g, "+").replace(/_/g, "/"))
	return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

/** A URL-safe token for one log: `[timestamp, service, traceId, spanId, recordIdentity]`. */
export function encodeLogKey(log: LogKey): string {
	return toBase64Url(
		JSON.stringify([log.timestamp, log.serviceName, log.traceId, log.spanId, log.recordIdentity]),
	)
}

/** The token back as a key, or `null` for anything malformed (a hand-edited or truncated URL). */
export function decodeLogKey(token: string | null | undefined): LogKey | null {
	if (!token) return null
	const parsed = Option.getOrNull(trySync(() => JSON.parse(fromBase64Url(token)) as unknown))
	if (!Array.isArray(parsed) || parsed.length !== 5) return null
	if (!parsed.every((part): part is string => typeof part === "string")) return null
	const [timestamp = "", serviceName = "", traceId = "", spanId = "", recordIdentity = ""] = parsed
	if (timestamp === "" || serviceName === "") return null
	return { timestamp, serviceName, traceId, spanId, recordIdentity }
}

/** True when `log` is the row a key names. */
export function matchesLogKey(log: LogKey, key: LogKey): boolean {
	return (
		log.timestamp === key.timestamp &&
		log.serviceName === key.serviceName &&
		log.traceId === key.traceId &&
		log.spanId === key.spanId &&
		(key.recordIdentity === "" || log.recordIdentity === key.recordIdentity)
	)
}

/** `YYYY-MM-DD HH:MM:SS.mmm` in UTC, the spelling the warehouse params read. */
function warehouseMs(epochMs: number): string {
	return new Date(epochMs).toISOString().replace("T", " ").replace(/Z$/, "")
}

const WAREHOUSE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/

/** The log's own instant as a bound: the stored literal when it reads as one, else its millisecond. */
function instantBound(timestamp: string, ms: number): string {
	return WAREHOUSE_DATETIME.test(timestamp) ? timestamp : warehouseMs(ms)
}

/** Bounds that hold exactly the key's instant, for looking the row up. */
export function logKeyBounds(key: LogKey): TimeBounds | null {
	const ms = parseClickHouseDateTime(key.timestamp)
	if (ms === null) return null
	const at = instantBound(key.timestamp, ms)
	return { startTime: at, endTime: at }
}

/**
 * The shareable hash for one log: the drawer open on it, over the stream
 * around it. Absolute (origin and path included), so it pastes anywhere.
 */
export function logPermalink(
	log: LogKey,
	base: string = `${window.location.origin}${window.location.pathname}`,
) {
	const query = new URLSearchParams({ [LOG_PARAM]: encodeLogKey(log) })
	const ms = parseClickHouseDateTime(log.timestamp)
	if (ms !== null) {
		query.set(
			"range",
			customRangeKey({ fromMs: ms - PERMALINK_WINDOW_MS, toMs: ms + PERMALINK_WINDOW_MS }),
		)
	}
	return `${base}${hrefFor("/logs", query)}`
}

export interface InstanceAttribute {
	readonly key: string
	readonly value: string
}

/** The resource attribute that names the log's running instance, when it carries one. */
export function instanceAttribute(log: Pick<LocalLog, "resourceAttributes">): InstanceAttribute | undefined {
	const key = INSTANCE_KEYS.find((candidate) => (log.resourceAttributes[candidate] ?? "") !== "")
	return key ? { key, value: log.resourceAttributes[key] ?? "" } : undefined
}

export interface ContextWindows {
	/** Newest-first up to and including the log's instant. */
	readonly before: TimeBounds
	/** Oldest-first from the log's instant. */
	readonly after: TimeBounds
}

/**
 * The two half-windows either side of a log. Both include its instant, so
 * neighbours that share its timestamp come back from both sides and are
 * deduped by {@link mergeLogContext}.
 */
export function contextWindows(timestamp: string): ContextWindows | null {
	const ms = parseClickHouseDateTime(timestamp)
	if (ms === null) return null
	const at = instantBound(timestamp, ms)
	return {
		before: { startTime: warehouseMs(ms - CONTEXT_WINDOW_MS), endTime: at },
		after: { startTime: at, endTime: warehouseMs(ms + CONTEXT_WINDOW_MS) },
	}
}

/** Row identity inside a context list: two identical records never merge. */
export function contextKey(log: LocalLog): string {
	return `${log.timestamp}|${log.serviceName}|${log.traceId}|${log.spanId}|${log.recordIdentity}`
}

/**
 * The selected log between its neighbours, oldest first: up to `size` from
 * each side, with the selected row (and anything both sides returned) once.
 */
export function mergeLogContext(
	selected: LocalLog,
	beforeDesc: ReadonlyArray<LocalLog>,
	afterAsc: ReadonlyArray<LocalLog>,
	size: number = CONTEXT_SIZE,
): LocalLog[] {
	const seen = new Set([contextKey(selected)])
	const unique = (rows: ReadonlyArray<LocalLog>) =>
		rows.filter((row) => {
			const key = contextKey(row)
			if (seen.has(key)) return false
			seen.add(key)
			return true
		})
	const before = unique(beforeDesc).slice(0, size).reverse()
	const after = unique(afterAsc).slice(0, size)
	return [...before, selected, ...after]
}
