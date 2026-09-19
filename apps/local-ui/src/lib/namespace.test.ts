import { afterEach, describe, expect, it, vi } from "vitest"
import {
	NAMESPACE_KEY,
	namespaceFilter,
	namespaceParam,
	persistNamespace,
	resolveNamespace,
	storedNamespace,
} from "./namespace"

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
	it("round-trips a project through localStorage", () => {
		const store = stubStorage()
		persistNamespace("reef")
		expect(store.get(NAMESPACE_KEY)).toBe("reef")
		expect(storedNamespace()).toBe("reef")
	})

	// "Nothing stored" and "stored as all projects" are the same answer, because
	// all projects is the default — a tri-state here would have no consequence.
	it("reads an explicit all-projects choice as no project", () => {
		stubStorage()
		persistNamespace(undefined)
		expect(storedNamespace()).toBeUndefined()
	})

	it("has no opinion when nothing was ever stored", () => {
		stubStorage()
		expect(storedNamespace()).toBeUndefined()
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
		expect(storedNamespace()).toBeUndefined()
		expect(() => persistNamespace("reef")).not.toThrow()
	})

	it("survives an environment with no storage at all", () => {
		vi.stubGlobal("localStorage", undefined)
		expect(storedNamespace()).toBeUndefined()
		expect(() => persistNamespace("reef")).not.toThrow()
	})
})

describe("resolution", () => {
	// A pasted link has to be the page the sender was looking at, whatever the
	// recipient happens to have selected.
	it("lets the param win over a contrary stored preference", () => {
		stubStorage({ [NAMESPACE_KEY]: "reef" })
		expect(resolveNamespace("git-smoke")).toBe("git-smoke")
	})

	it("falls back to the stored preference when the URL says nothing", () => {
		stubStorage({ [NAMESPACE_KEY]: "reef" })
		expect(resolveNamespace(null)).toBe("reef")
		expect(resolveNamespace(undefined)).toBe("reef")
		expect(resolveNamespace("")).toBe("reef")
	})

	it("is all projects when neither says anything", () => {
		stubStorage()
		expect(resolveNamespace(null)).toBeUndefined()
	})
})

describe("param and builder option", () => {
	it("writes the param only for a chosen project", () => {
		expect(namespaceParam("reef")).toBe("reef")
		expect(namespaceParam(undefined)).toBeNull()
	})

	// All projects must be the *absence* of a filter, not a different one: the
	// SQL has to be the SQL the view emitted before the selector existed.
	it("passes no namespaces at all for all projects", () => {
		expect(namespaceFilter("reef")).toEqual(["reef"])
		expect(namespaceFilter(undefined)).toBeUndefined()
		expect(namespaceFilter("")).toBeUndefined()
	})
})
