import { afterEach, describe, expect, it } from "vitest"
import { HIDE_INTERNAL_KEY, internalParam, persistHideInternal, resolveHideInternal } from "./internal-traffic"

const store = new Map<string, string>()
const fakeStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
}

describe("internal traffic preference", () => {
	afterEach(() => {
		store.clear()
		delete (globalThis as { localStorage?: unknown }).localStorage
	})

	it("hides by default, and the URL param wins over the stored choice", () => {
		expect(resolveHideInternal(null)).toBe(true)
		;(globalThis as { localStorage?: unknown }).localStorage = fakeStorage
		persistHideInternal(false)
		expect(store.get(HIDE_INTERNAL_KEY)).toBe("false")
		expect(resolveHideInternal(null)).toBe(false)
		expect(resolveHideInternal("0")).toBe(true)
		expect(resolveHideInternal("1")).toBe(false)
	})

	it("puts only the exception in the URL", () => {
		expect(internalParam(true)).toBeNull()
		expect(internalParam(false)).toBe("1")
	})

	it("survives a storage that throws", () => {
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			get() {
				throw new Error("sandboxed")
			},
		})
		expect(resolveHideInternal(null)).toBe(true)
		expect(() => persistHideInternal(true)).not.toThrow()
	})
})
