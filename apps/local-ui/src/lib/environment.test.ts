import { afterEach, describe, expect, it, vi } from "vitest"
import {
	ENVIRONMENT_KEY,
	UNKNOWN_ENVIRONMENT,
	environmentLabel,
	environmentParam,
	persistEnvironment,
	resolveEnvironment,
	storedEnvironment,
} from "./environment"

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

describe("stored preference", () => {
	it("round-trips an environment through localStorage", () => {
		const store = stubStorage()
		persistEnvironment("production")
		expect(store.get(ENVIRONMENT_KEY)).toBe("production")
		expect(storedEnvironment()).toBe("production")
	})

	// "Nothing stored" and "stored as all environments" are the same answer: all
	// environments is the default, so a tri-state here would have no consequence.
	it("reads an explicit all-environments choice as no environment", () => {
		stubStorage()
		persistEnvironment(undefined)
		expect(storedEnvironment()).toBeUndefined()
	})

	it("has no opinion when nothing was ever stored", () => {
		stubStorage()
		expect(storedEnvironment()).toBeUndefined()
	})

	// The project selector's own key, so a stored project can never be read back
	// as an environment by a typo in one of the two constants.
	it("does not share a key with the project filter", () => {
		const store = stubStorage()
		persistEnvironment("production")
		expect([...store.keys()]).toEqual([ENVIRONMENT_KEY])
		expect(ENVIRONMENT_KEY).not.toBe("maple.local.namespace")
	})

	it("survives a storage that refuses to be read or written", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("SecurityError")
			},
			setItem: () => {
				throw new Error("QuotaExceededError")
			},
		})
		expect(storedEnvironment()).toBeUndefined()
		expect(() => persistEnvironment("production")).not.toThrow()
	})

	it("survives an environment with no storage at all", () => {
		vi.stubGlobal("localStorage", undefined)
		expect(storedEnvironment()).toBeUndefined()
		expect(() => persistEnvironment("production")).not.toThrow()
	})
})

describe("resolution", () => {
	// A pasted link has to be the page the sender was looking at, whatever the
	// recipient happens to have selected — and `env` is also five views' own
	// sidebar facet, so the param is frequently the more specific statement.
	it("lets the param win over a contrary stored preference", () => {
		stubStorage({ [ENVIRONMENT_KEY]: "production" })
		expect(resolveEnvironment("staging")).toBe("staging")
	})

	it("falls back to the stored preference when the URL says nothing", () => {
		stubStorage({ [ENVIRONMENT_KEY]: "production" })
		expect(resolveEnvironment(null)).toBe("production")
		expect(resolveEnvironment(undefined)).toBe("production")
		expect(resolveEnvironment("")).toBe("production")
	})

	it("is all environments when neither says anything", () => {
		stubStorage()
		expect(resolveEnvironment(null)).toBeUndefined()
	})
})

describe("param", () => {
	it("writes the param only for a chosen environment", () => {
		expect(environmentParam("production")).toBe("production")
		expect(environmentParam(undefined)).toBeNull()
		expect(environmentParam("")).toBeNull()
	})
})

describe("the unknown environment", () => {
	// `unknown` is a value like any other on the wire: it is what the query
	// engine's `envLabel` puts in the facet lists and what its predicates match,
	// so the param, the stored preference and the SQL literal are one string.
	it("is a selectable environment, not an absence of one", () => {
		expect(environmentParam(UNKNOWN_ENVIRONMENT)).toBe("unknown")
		stubStorage()
		persistEnvironment(UNKNOWN_ENVIRONMENT)
		expect(storedEnvironment()).toBe("unknown")
		expect(resolveEnvironment(null)).toBe("unknown")
	})

	// Capitalised only where it is read as a caption. Everything else — the
	// param, the storage, the facet rows — keeps the value it was given.
	it("is captioned Unknown and leaves chosen names alone", () => {
		expect(environmentLabel(UNKNOWN_ENVIRONMENT)).toBe("Unknown")
		expect(environmentLabel("production")).toBe("production")
		expect(environmentLabel("pr-4417")).toBe("pr-4417")
	})
})
