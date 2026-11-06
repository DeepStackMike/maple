import { describe, expect, it } from "vitest"
import { describeDeployedVersion } from "./deployed-version"

describe("describeDeployedVersion", () => {
	it("names Maple's version and the short build commit", () => {
		const out = describeDeployedVersion("0.3.4", "8e354fe3365334b8e9603a7362b84e2cc90a3c39")
		expect(out?.label).toBe("Maple v0.3.4 · UI 8e354fe")
		expect(out?.title).toContain("8e354fe3365334b8e9603a7362b84e2cc90a3c39")
	})

	it("shows whichever half is known", () => {
		expect(describeDeployedVersion("0.3.4", "")?.label).toBe("Maple v0.3.4")
		expect(describeDeployedVersion(null, "abcdef1234")?.label).toBe("UI abcdef1")
	})

	it("renders nothing before the first probe in a dev build", () => {
		expect(describeDeployedVersion(null, "")).toBeNull()
	})
})
