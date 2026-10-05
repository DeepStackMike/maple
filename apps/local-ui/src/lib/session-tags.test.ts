import { describe, expect, it } from "vitest"
import {
	nextTagSelection,
	noiseTierOf,
	sessionTagsFromParam,
	sessionTagsOf,
	sessionTagsToParam,
} from "./session-tags"

describe("nextTagSelection", () => {
	it("replaces the selected tier when another tier is ticked", () => {
		expect(nextTagSelection(["engaged"], ["engaged", "bounce"])).toEqual(["bounce"])
	})

	it("keeps traits alongside a newly ticked tier", () => {
		expect(nextTagSelection(["engaged", "signed_in"], ["engaged", "signed_in", "bot"])).toEqual([
			"signed_in",
			"bot",
		])
	})

	it("combines traits with each other and with the tier", () => {
		expect(nextTagSelection(["engaged"], ["engaged", "signed_in", "new_visitor"])).toEqual([
			"engaged",
			"signed_in",
			"new_visitor",
		])
	})

	it("unticks without touching the rest, and drops unknown values", () => {
		expect(nextTagSelection(["engaged", "signed_in"], ["signed_in", "frustrated"])).toEqual(["signed_in"])
	})
})

describe("noiseTierOf", () => {
	it("flags every tier but engaged, and ignores traits", () => {
		expect(noiseTierOf(["glance", "signed_in"])).toBe("glance")
		expect(noiseTierOf(["engaged", "new_visitor"])).toBeUndefined()
	})
})

describe("tags param", () => {
	it("reads valid tags in display order and drops unknown ones", () => {
		expect(sessionTagsFromParam("new_visitor,frustrated,bot")).toEqual(["bot", "new_visitor"])
		expect(sessionTagsFromParam(null)).toEqual([])
		expect(sessionTagsFromParam("")).toEqual([])
	})

	it("round-trips, and an empty selection clears the param", () => {
		expect(sessionTagsFromParam(sessionTagsToParam(["engaged", "signed_in"]))).toEqual([
			"engaged",
			"signed_in",
		])
		expect(sessionTagsToParam([])).toBeNull()
	})
})

describe("sessionTagsOf", () => {
	it("derives the tier plus the traits from the list columns", () => {
		expect(sessionTagsOf({ quality: "engaged", userId: "u1", visitorIsNew: 1 })).toEqual([
			"engaged",
			"signed_in",
			"new_visitor",
		])
		// ClickHouse JSON can hand a UInt8 back as a string.
		expect(sessionTagsOf({ quality: "bot", userId: "", visitorIsNew: "0" })).toEqual(["bot"])
		expect(sessionTagsOf({ quality: "", userId: "", visitorIsNew: "1" })).toEqual(["new_visitor"])
	})
})
