import { useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { Option } from "effect"
import type {
	SessionReplayDetailOutput,
	SessionSpanOutput,
	SessionTraceSummaryOutput,
	SessionTranscriptOutput,
} from "@maple/query-engine/ch"
import { executeLocalCompiledFirstRow, executeLocalCompiledQuery } from "@/lib/query"
import { LOCAL_ORG_ID } from "../lib/constants"

/** Finalized metadata for one session (latest ReplacingMergeTree version). */
export function useLocalSessionDetail(sessionId: string | undefined) {
	return useQuery<SessionReplayDetailOutput | null>({
		queryKey: ["local", "session", sessionId],
		enabled: !!sessionId,
		queryFn: async () => {
			const compiled = CH.compile(CH.getSessionReplayQuery(), {
				orgId: LOCAL_ORG_ID,
				sessionId: sessionId!,
			})
			const row = await executeLocalCompiledFirstRow(compiled)
			return Option.getOrNull(row)
		},
	})
}

/** Distilled event transcript (navigation / click / console / network / error). */
export function useLocalSessionTranscript(sessionId: string | undefined) {
	return useQuery<ReadonlyArray<SessionTranscriptOutput>>({
		queryKey: ["local", "session-transcript", sessionId],
		enabled: !!sessionId,
		queryFn: async () => {
			const compiled = CH.compile(CH.sessionTranscriptQuery({ limit: 250 }), {
				orgId: LOCAL_ORG_ID,
				sessionId: sessionId!,
			})
			return executeLocalCompiledQuery(compiled)
		},
	})
}

/** Per-trace summaries for the session's correlated backend traces. */
export function useLocalSessionTraces(traceIds: ReadonlyArray<string> | undefined) {
	return useQuery<ReadonlyArray<SessionTraceSummaryOutput>>({
		queryKey: ["local", "session-traces", traceIds],
		enabled: !!traceIds && traceIds.length > 0,
		queryFn: async () => {
			const compiled = CH.compile(CH.sessionTraceSummariesQuery({ traceIds: traceIds! }), {
				orgId: LOCAL_ORG_ID,
			})
			return executeLocalCompiledQuery(compiled)
		},
	})
}

/**
 * Every span carrying this session's `session.id` attribute.
 *
 * Two jobs, one scan. It is the reverse link — the traces this session caused,
 * including for an active session whose `TraceIds` nobody has written yet — and
 * it is the raw material the transcript matches its trace-id-less `network`
 * rows against. 500 spans is the cap: the matcher needs breadth across the
 * session, not every span of every trace.
 *
 * The window comes from `sessionSpanWindow`, rounded to the minute, so the
 * query key is stable across renders — an unrounded `Date.now()` end for an
 * active session would make every render a cache miss.
 */
export function useLocalSessionSpans(
	sessionId: string | undefined,
	window: { readonly startTime: string; readonly endTime: string } | undefined,
) {
	return useQuery<ReadonlyArray<SessionSpanOutput>>({
		queryKey: ["local", "session-spans", sessionId, window?.startTime, window?.endTime],
		enabled: !!sessionId && !!window,
		queryFn: async () => {
			const compiled = CH.compile(
				CH.sessionSpansQuery({ startTime: window!.startTime, endTime: window!.endTime }),
				{ orgId: LOCAL_ORG_ID, sessionId: sessionId! },
			)
			return executeLocalCompiledQuery(compiled)
		},
	})
}
