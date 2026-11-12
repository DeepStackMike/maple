// Hiding the owner's own sessions.
//
// The Harbr ingest sidecar stamps every `session_replays` row with
// `harbr.traffic` = `internal` | `external` in `ResourceAttributes` (see
// services/harbr-apps-maple/session-ingest/README.md, "Internal traffic"):
// `internal` when the session is identified as the owner, carries the device
// opt-in flag, or came from an address one of those did recently.
//
// The tag is NOT version-invariant, unlike the environment beside it. A session
// posts its metadata many times, and an early version can be `external` because
// the address had not been learned yet, or the user not yet identified, while a
// later one is `internal`. A row-level `!= 'internal'` would therefore keep the
// early versions and surface the session with stale fields. So the filter is a
// semi-join instead: a session is internal when ANY version marked it so within
// the window, and `hide` / `only` drop or keep exactly those. "Ever internal"
// is the right reading too: the classifier only ever learns that a session is
// the owner's, it never learns that one is not.

import * as CH from "@maple-dev/effect-orm/expr"
import { from, inSubquery, param } from "@maple-dev/effect-orm/clickhouse"
import { SessionReplays, orgIdParam } from "../tables"

/** The resource attribute the sidecar writes, and the value that marks the owner. */
export const INTERNAL_TRAFFIC_ATTRIBUTE = "harbr.traffic"
export const INTERNAL_TRAFFIC_VALUE = "internal"

/** `SELECT SessionId FROM session_replays WHERE <window> AND harbr.traffic = 'internal'`. */
function internalSessionsSubquery() {
	return from(SessionReplays)
		.select(($) => ({ sessionId: $.SessionId }))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.StartTime.gte(param.dateTime("startTime")),
			$.StartTime.lte(param.dateTime("endTime")),
			$.ResourceAttributes.get(INTERNAL_TRAFFIC_ATTRIBUTE).eq(INTERNAL_TRAFFIC_VALUE),
		])
		.groupBy("sessionId")
}

/**
 * Which side of the owner/visitor split a page shows: `hide` drops internal
 * sessions, `only` keeps nothing else. Absent means both.
 */
export type InternalTrafficMode = "hide" | "only"

/**
 * The condition for a mode, or `undefined` for all traffic. Matches on
 * `SessionId`, so it applies to any table that carries one: `session_replays`,
 * `session_events`, `product_events`.
 */
export function internalTrafficCondition(
	sessionId: CH.Expr<string>,
	mode: InternalTrafficMode | undefined,
): CH.Condition | undefined {
	if (mode === undefined) return undefined
	const internal = inSubquery(sessionId, internalSessionsSubquery())
	return mode === "only" ? internal : CH.not(internal)
}
