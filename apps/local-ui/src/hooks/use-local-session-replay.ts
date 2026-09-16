import { useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import type { SessionReplayEventsOutput } from "@maple/query-engine/ch"
import { executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"

/** The rrweb `meta` event's viewport, when the stream carries one. */
export interface ReplayViewport {
	readonly width: number
	readonly height: number
}

export interface LocalSessionReplay {
	/** Concatenated, chronologically ordered rrweb events across every chunk. */
	readonly events: ReadonlyArray<unknown>
	readonly chunkCount: number
	readonly byteSize: number
	/** From the last `meta` event in the stream; `undefined` when absent. */
	readonly viewport: ReplayViewport | undefined
}

/**
 * Local mode loads a session's whole recording in one query. The cloud player
 * pages chunks through a chunk index because its Worker has a 128 MB budget;
 * here the SPA talks straight to the embedded database and evaluation-scale
 * sessions are a few MB, so the simpler path wins. `limit` is the safety rail.
 */
const CHUNK_LIMIT = 2000

const hasTimestamp = (event: unknown): event is { timestamp: number } =>
	typeof event === "object" && event !== null && "timestamp" in event && typeof event.timestamp === "number"

const timestampOf = (event: unknown): number => (hasTimestamp(event) ? event.timestamp : 0)

/**
 * Stable-sort by timestamp and drop exact adjacent duplicates, mirroring the
 * web player's `normalizeEvents`: an rrweb stream assembled from chunks must be
 * chronological or `getMetaData().totalTime` balloons and seeking misbehaves.
 */
export function normalizeReplayEvents(events: ReadonlyArray<unknown>): unknown[] {
	const sorted = events.map((event, index) => ({ event, index })).sort((a, b) => {
		const delta = timestampOf(a.event) - timestampOf(b.event)
		return delta !== 0 ? delta : a.index - b.index
	})
	const out: unknown[] = []
	let previous: string | undefined
	for (const { event } of sorted) {
		const key = JSON.stringify(event)
		if (key !== previous) out.push(event)
		previous = key
	}
	return out
}

/** rrweb `EventType.Meta` is 4; its data carries the recorded viewport. */
export function viewportOf(events: ReadonlyArray<unknown>): ReplayViewport | undefined {
	let viewport: ReplayViewport | undefined
	for (const event of events) {
		if (typeof event !== "object" || event === null) continue
		const e = event as { type?: unknown; data?: { width?: unknown; height?: unknown } }
		if (e.type === 4 && typeof e.data?.width === "number" && typeof e.data?.height === "number") {
			viewport = { width: e.data.width, height: e.data.height }
		}
	}
	return viewport
}

export function assembleReplay(rows: ReadonlyArray<SessionReplayEventsOutput>): LocalSessionReplay {
	const events: unknown[] = []
	let byteSize = 0
	for (const row of rows) {
		byteSize += row.byteSize
		let parsed: unknown
		try {
			parsed = JSON.parse(row.events)
		} catch {
			continue
		}
		if (Array.isArray(parsed)) events.push(...parsed)
	}
	const normalized = normalizeReplayEvents(events)
	return { events: normalized, chunkCount: rows.length, byteSize, viewport: viewportOf(normalized) }
}

/** Every rrweb chunk for one session, assembled into a playable stream. */
export function useLocalSessionReplay(sessionId: string | undefined, enabled = true) {
	return useQuery<LocalSessionReplay>({
		queryKey: ["local", "session-replay", sessionId],
		enabled: !!sessionId && enabled,
		staleTime: Number.POSITIVE_INFINITY,
		queryFn: async () => {
			const compiled = CH.compile(CH.sessionReplayEventsQuery({ limit: CHUNK_LIMIT }), {
				orgId: LOCAL_ORG_ID,
				sessionId: sessionId!,
			})
			const rows = await executeLocalCompiledQuery(compiled)
			return assembleReplay(rows)
		},
	})
}
