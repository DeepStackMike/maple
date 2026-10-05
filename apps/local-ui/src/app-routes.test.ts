import { describe, expect, it } from "vitest"
import { parseRoute } from "./App"

describe("parseRoute", () => {
	it("routes every top-level tab to its own view", () => {
		for (const name of [
			"traces",
			"logs",
			"metrics",
			"services",
			"service-map",
			"errors",
			"sessions",
			"analytics",
		]) {
			expect(parseRoute(`/${name}`)).toEqual({ name })
		}
	})

	it("lands on Home for the root, /home, and anything unknown", () => {
		for (const path of ["/", "/home", "/nope"]) expect(parseRoute(path)).toEqual({ name: "home" })
	})

	it("decodes detail ids", () => {
		expect(parseRoute("/traces/abc%2F1")).toEqual({ name: "trace-detail", traceId: "abc/1" })
		expect(parseRoute("/services/api")).toEqual({ name: "service-detail", serviceName: "api" })
	})
})
