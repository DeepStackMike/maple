import { describe, expect, it } from "vitest"
import { paramsAfterProjectChange } from "./project-switch"

const from = (query: string) => new URLSearchParams(query)

describe("paramsAfterProjectChange", () => {
	it("drops every page filter and keeps the standing choices", () => {
		const next = paramsAfterProjectChange(
			from(
				"range=6h&mode=patterns&service=api&severity=ERROR&attrs=log%3Ak%3Dv&q=boom&tags=engaged&log=abc&ns=shop",
			),
			"git-smoke",
			true,
		)
		expect(next.toString()).toBe("range=6h&mode=patterns&ns=git-smoke")
	})

	it("keeps the environment only when the new project reports it", () => {
		expect(paramsAfterProjectChange(from("env=production"), "git-smoke", true).get("env")).toBe(
			"production",
		)
		expect(paramsAfterProjectChange(from("env=staging"), "git-smoke", false).has("env")).toBe(false)
	})

	it("keeps the health-check toggle but not the services health facet", () => {
		expect(paramsAfterProjectChange(from("health=1"), "a", true).get("health")).toBe("1")
		expect(paramsAfterProjectChange(from("health=degraded"), "a", true).has("health")).toBe(false)
	})

	it("drops ns for All projects, along with the filters", () => {
		expect(
			paramsAfterProjectChange(from("ns=shop&service=api&range=1h"), undefined, true).toString(),
		).toBe("range=1h")
	})
})
