// Hiding the owner's own sessions.
//
// The Harbr ingest sidecar tags each session `harbr.traffic=internal` when it is
// the owner's: identified as them, flagged on their device, or from an address
// one of those came from recently (services/harbr-apps-maple/session-ingest,
// "Internal traffic"). The owner browsing their own apps is most of the
// sessions a small site records, so the session pages hide it by default.
//
// Built exactly like `lib/health-checks.ts`: a toolbar toggle remembered in the
// browser, mirrored into the URL as the exception (`internal=1` shows them), so
// a link to the ordinary view carries no query string and a link to the other
// one says so. The query engine side is `excludeInternalSessions`.

/** Hidden unless the reader says otherwise: the point is to see other people. */
export const DEFAULT_HIDE_INTERNAL = true

export const HIDE_INTERNAL_KEY = "maple.local.hideInternal"

/** The remembered preference, or `undefined`. Guarded like `storedHideHealthChecks`. */
export function storedHideInternal(): boolean | undefined {
	try {
		const raw = globalThis.localStorage?.getItem(HIDE_INTERNAL_KEY)
		return raw === "true" ? true : raw === "false" ? false : undefined
	} catch {
		return undefined
	}
}

/** Remember the choice for the next visit. Failure to store is not failure to toggle. */
export function persistHideInternal(hide: boolean): void {
	try {
		globalThis.localStorage?.setItem(HIDE_INTERNAL_KEY, hide ? "true" : "false")
	} catch {
		// A storage quota or a blocked origin: the toggle still applies to this view.
	}
}

/** Whether to hide internal sessions, given the URL's `internal` param. The param wins. */
export function resolveHideInternal(param: string | null | undefined): boolean {
	if (param === "1") return false
	if (param === "0") return true
	return storedHideInternal() ?? DEFAULT_HIDE_INTERNAL
}

/** The `internal` param for a choice: `null` clears it, which is the default view. */
export function internalParam(hide: boolean): string | null {
	return hide === DEFAULT_HIDE_INTERNAL ? null : hide ? "0" : "1"
}
