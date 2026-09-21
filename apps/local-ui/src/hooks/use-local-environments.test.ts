import { describe, expect, it } from "vitest"
import { mergeEnvironments } from "./use-local-environments"

// The selector's options come from two GROUP BYs over two different tables —
// spans and browser sessions — and a Maple almost always reports overlapping
// sets. The merge is what makes that one list.
describe("mergeEnvironments", () => {
	it("is the union of both lists, alphabetical and without repeats", () => {
		expect(mergeEnvironments(["production", "staging"], ["production", "unknown"])).toEqual([
			"production",
			"staging",
			"unknown",
		])
	})

	// The case this hook was split in two for: every span is tagged, so the
	// service list has no `unknown` in it, while two of the recorded sessions
	// carry no environment attribute at all. The option has to come from the
	// sessions or those rows are unreachable.
	it("offers `unknown` when only the sessions lack an environment", () => {
		expect(mergeEnvironments(["evaluation", "production"], ["production", "unknown"])).toContain(
			"unknown",
		)
	})

	it("offers nothing when neither table has seen anything", () => {
		expect(mergeEnvironments([], [])).toEqual([])
	})
})
