// Showing or hiding the owner's own sessions.
//
// The Harbr ingest sidecar tags each session `harbr.traffic=internal` when it is
// the owner's: identified as them, flagged on their device, or from an address
// one of those came from recently (services/harbr-apps-maple/session-ingest,
// "Internal traffic"). The owner browsing their own apps is most of the
// sessions a small site records, so the session pages hide it by default; the
// other two modes show everything, or only the owner's (to check what the
// classifier caught).
//
// Built like `lib/health-checks.ts`: a toolbar control remembered in the
// browser, mirrored into the URL as the exception (`internal=1` for all,
// `internal=only`), so a link to the ordinary view carries no query string. The
// query engine side is `internalTrafficCondition`.

import type { InternalTrafficMode as EngineMode } from "@maple/query-engine/ch"

export type InternalTrafficMode = "hide" | "all" | "only"

export const INTERNAL_TRAFFIC_MODES: ReadonlyArray<{ readonly key: InternalTrafficMode; readonly label: string }> = [
	{ key: "hide", label: "Hide internal" },
	{ key: "all", label: "All traffic" },
	{ key: "only", label: "Only internal" },
]

/** Hidden unless the reader says otherwise: the point is to see other people. */
export const DEFAULT_INTERNAL_TRAFFIC: InternalTrafficMode = "hide"

export const INTERNAL_TRAFFIC_KEY = "maple.local.internalTraffic"
/** The checkbox's key before the third mode existed: `"true"` hid, `"false"` showed all. */
const LEGACY_HIDE_INTERNAL_KEY = "maple.local.hideInternal"

const parseMode = (raw: string | null | undefined): InternalTrafficMode | undefined =>
	raw === "hide" || raw === "all" || raw === "only" ? raw : undefined

/** The remembered mode, or `undefined`. Guarded like `storedHideHealthChecks`. */
export function storedInternalTraffic(): InternalTrafficMode | undefined {
	try {
		const storage = globalThis.localStorage
		const mode = parseMode(storage?.getItem(INTERNAL_TRAFFIC_KEY))
		if (mode !== undefined) return mode
		const legacy = storage?.getItem(LEGACY_HIDE_INTERNAL_KEY)
		return legacy === "true" ? "hide" : legacy === "false" ? "all" : undefined
	} catch {
		return undefined
	}
}

/** Remember the choice for the next visit. Failure to store is not failure to switch. */
export function persistInternalTraffic(mode: InternalTrafficMode): void {
	try {
		globalThis.localStorage?.setItem(INTERNAL_TRAFFIC_KEY, mode)
	} catch {
		// A storage quota or a blocked origin: the choice still applies to this view.
	}
}

/**
 * The mode for the URL's `internal` param. The param wins over the stored
 * choice. `1` and `0` are the checkbox's old spellings (show all / hide), kept
 * so links made before the third mode still mean what they meant.
 */
export function resolveInternalTraffic(param: string | null | undefined): InternalTrafficMode {
	if (param === "1") return "all"
	if (param === "0") return "hide"
	return parseMode(param) ?? storedInternalTraffic() ?? DEFAULT_INTERNAL_TRAFFIC
}

/** The `internal` param for a mode: `null` clears it, which is the default view. */
export function internalTrafficParam(mode: InternalTrafficMode): string | null {
	return mode === DEFAULT_INTERNAL_TRAFFIC ? null : mode
}

/** The query engine's option for a mode: none at all for all traffic. */
export function engineInternalTraffic(mode: InternalTrafficMode): EngineMode | undefined {
	return mode === "all" ? undefined : mode
}
