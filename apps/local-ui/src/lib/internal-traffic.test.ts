import { afterEach, describe, expect, it } from "vitest"
import {
	engineInternalTraffic,
	INTERNAL_TRAFFIC_KEY,
	internalTrafficParam,
	persistInternalTraffic,
	resolveInternalTraffic,
} from "./internal-traffic"

const store = new Map<string, string>()
const fakeStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
}
const g = globalThis as { localStorage?: unknown }

describe("internal traffic mode", () => {
	afterEach(() => {
		store.clear()
		delete g.localStorage
	})

	it("hides by default, and the URL param wins over the stored choice", () => {
		expect(resolveInternalTraffic(null)).toBe("hide")
		g.localStorage = fakeStorage
		persistInternalTraffic("only")
		expect(store.get(INTERNAL_TRAFFIC_KEY)).toBe("only")
		expect(resolveInternalTraffic(null)).toBe("only")
		expect(resolveInternalTraffic("all")).toBe("all")
		expect(resolveInternalTraffic("hide")).toBe("hide")
		expect(resolveInternalTraffic("bogus")).toBe("only")
	})

	it("keeps the checkbox's old URL values and stored preference", () => {
		expect(resolveInternalTraffic("1")).toBe("all")
		expect(resolveInternalTraffic("0")).toBe("hide")
		g.localStorage = fakeStorage
		store.set("maple.local.hideInternal", "false")
		expect(resolveInternalTraffic(null)).toBe("all")
	})

	it("puts only the exception in the URL, and all traffic sends no engine option", () => {
		expect(internalTrafficParam("hide")).toBeNull()
		expect(internalTrafficParam("only")).toBe("only")
		expect(engineInternalTraffic("all")).toBeUndefined()
		expect(engineInternalTraffic("only")).toBe("only")
	})

	it("survives a storage that throws", () => {
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			get() {
				throw new Error("sandboxed")
			},
		})
		expect(resolveInternalTraffic(null)).toBe("hide")
		expect(() => persistInternalTraffic("all")).not.toThrow()
	})
})
