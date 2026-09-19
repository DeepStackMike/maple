import { afterEach, describe, expect, it, vi } from "vitest"
import {
	DEFAULT_HIDE_HEALTH_CHECKS,
	HEALTH_CHECK_PATTERNS,
	HIDE_HEALTH_CHECKS_KEY,
	healthCheckParam,
	healthCheckPatterns,
	persistHideHealthChecks,
	resolveHideHealthChecks,
	storedHideHealthChecks,
} from "./health-checks"

/** Minimal `localStorage`, plus the two ways a real one refuses to be one. */
function stubStorage(initial?: Record<string, string>) {
	const store = new Map(Object.entries(initial ?? {}))
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
	})
	return store
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("patterns", () => {
	// `%/health%` subsumes `/healthz` and `/api/health`, so both are covered
	// without a pattern of their own.
	it("covers every documented probe route", () => {
		const matches = (route: string) =>
			HEALTH_CHECK_PATTERNS.some((pattern) => route.includes(pattern.replaceAll("%", "")))
		for (const route of [
			"/health",
			"/healthz",
			"/ready",
			"/live",
			"/ping",
			"/api/health",
			"/api/telemetry",
		]) {
			expect(matches(route), route).toBe(true)
		}
	})

	// KNOWN over-match, pinned rather than fixed: the patterns are substrings, so
	// a real route with `/health` inside it (`/v2/patients/{id}/healthcare`) is
	// hidden too. Anchoring the pattern would trade it for the opposite miss —
	// `/api/v1/health` and `GET /health` are both legitimately prefixed — and the
	// toggle is one click away, which an anchored pattern that silently missed a
	// probe would not be.
	it("leaves ordinary routes alone, and over-matches a route spelled like a probe", () => {
		const matches = (route: string) =>
			HEALTH_CHECK_PATTERNS.some((pattern) => route.includes(pattern.replaceAll("%", "")))
		expect(matches("/v2/alerts")).toBe(false)
		expect(matches("/checkout")).toBe(false)
		expect(matches("/v2/patients/{id}/healthcare")).toBe(true)
	})

	// Showing the probes is the absence of a filter, not a different one — the
	// SQL has to be the SQL the list emitted before the toggle existed.
	it("passes no patterns at all when the probes are wanted", () => {
		expect(healthCheckPatterns(true)).toBe(HEALTH_CHECK_PATTERNS)
		expect(healthCheckPatterns(false)).toBeUndefined()
	})
})

describe("stored preference", () => {
	it("round-trips through localStorage", () => {
		const store = stubStorage()
		persistHideHealthChecks(false)
		expect(store.get(HIDE_HEALTH_CHECKS_KEY)).toBe("false")
		expect(storedHideHealthChecks()).toBe(false)

		persistHideHealthChecks(true)
		expect(storedHideHealthChecks()).toBe(true)
	})

	it("has no opinion when nothing was ever stored", () => {
		stubStorage()
		expect(storedHideHealthChecks()).toBeUndefined()
	})

	it("ignores a value it did not write", () => {
		stubStorage({ [HIDE_HEALTH_CHECKS_KEY]: "yes" })
		expect(storedHideHealthChecks()).toBeUndefined()
	})

	// A sandboxed iframe throws on the `localStorage` getter itself; a list must
	// still render.
	it("survives a storage that refuses to be read or written", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("SecurityError")
			},
			setItem: () => {
				throw new Error("QuotaExceededError")
			},
		})
		expect(storedHideHealthChecks()).toBeUndefined()
		expect(() => persistHideHealthChecks(true)).not.toThrow()
	})

	it("survives an environment with no storage at all", () => {
		vi.stubGlobal("localStorage", undefined)
		expect(storedHideHealthChecks()).toBeUndefined()
		expect(() => persistHideHealthChecks(false)).not.toThrow()
	})
})

describe("resolution", () => {
	it("hides the probes by default", () => {
		stubStorage()
		expect(resolveHideHealthChecks(null)).toBe(DEFAULT_HIDE_HEALTH_CHECKS)
		expect(resolveHideHealthChecks(undefined)).toBe(true)
	})

	// A pasted link has to be the page the sender was looking at, whatever the
	// recipient's own preference is.
	it("lets the param override a contrary stored preference, both ways", () => {
		stubStorage({ [HIDE_HEALTH_CHECKS_KEY]: "true" })
		expect(resolveHideHealthChecks("1")).toBe(false)

		stubStorage({ [HIDE_HEALTH_CHECKS_KEY]: "false" })
		expect(resolveHideHealthChecks("0")).toBe(true)
	})

	it("falls back to the stored preference when the URL says nothing", () => {
		stubStorage({ [HIDE_HEALTH_CHECKS_KEY]: "false" })
		expect(resolveHideHealthChecks(null)).toBe(false)
		// A param value neither spelling recognizes is not a statement.
		expect(resolveHideHealthChecks("maybe")).toBe(false)
	})

	// The default view carries no query string, so the ordinary link is the short one.
	it("writes the param only for the exception", () => {
		expect(healthCheckParam(true)).toBeNull()
		expect(healthCheckParam(false)).toBe("1")
	})
})
