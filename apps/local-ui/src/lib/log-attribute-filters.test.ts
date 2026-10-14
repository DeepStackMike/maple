import { describe, expect, it } from "vitest"
import {
	addLogAttributeFilter,
	decodeLogAttributeFilter,
	decodeLogAttributeFilters,
	encodeLogAttributeFilter,
	logAttributeQueryFilters,
	removeLogAttributeFilter,
	type LogAttributeFilter,
} from "./log-attribute-filters"

const route: LogAttributeFilter = { source: "log", key: "http.route", value: "/api/users", negated: false }

describe("encode / decode", () => {
	it("round-trips keys and values holding = and %", () => {
		const filter: LogAttributeFilter = {
			source: "resource",
			key: "a=b%c",
			value: "x=1&y=%2",
			negated: true,
		}
		expect(decodeLogAttributeFilter(encodeLogAttributeFilter(filter))).toEqual(filter)
	})

	it("spells log and resource filters the way hosted links do", () => {
		expect(encodeLogAttributeFilter(route)).toBe("log:http.route=/api/users")
		expect(
			encodeLogAttributeFilter({
				source: "resource",
				key: "k8s.pod.name",
				value: "web-1",
				negated: true,
			}),
		).toBe("!res:k8s.pod.name=web-1")
	})

	it("keeps an empty value", () => {
		expect(decodeLogAttributeFilter("log:user.id=")).toEqual({
			source: "log",
			key: "user.id",
			value: "",
			negated: false,
		})
	})

	it("drops entries that are not in the attrs spelling", () => {
		expect(decodeLogAttributeFilters(["nonsense", "span:a=b", "log:=x", "log:ok=1"])).toEqual([
			{ source: "log", key: "ok", value: "1", negated: false },
		])
	})
})

describe("addLogAttributeFilter", () => {
	it("replaces the opposite polarity instead of keeping both", () => {
		const included = addLogAttributeFilter([], route)
		expect(addLogAttributeFilter(included, { ...route, negated: true })).toEqual([
			"!log:http.route=/api/users",
		])
	})

	it("never duplicates an entry", () => {
		const once = addLogAttributeFilter(["log:a=1"], route)
		expect(addLogAttributeFilter(once, route)).toEqual(["log:a=1", "log:http.route=/api/users"])
	})
})

describe("removeLogAttributeFilter", () => {
	it("removes only the named entry", () => {
		expect(removeLogAttributeFilter(["log:a=1", "!res:b=2"], "log:a=1")).toEqual(["!res:b=2"])
	})
})

describe("logAttributeQueryFilters", () => {
	it("splits entries into the log and resource maps as exact matches", () => {
		expect(logAttributeQueryFilters(["log:a=1", "!res:b=2", "!log:c=3"])).toEqual({
			attributeFilters: [
				{ key: "a", value: "1", mode: "equals" },
				{ key: "c", value: "3", mode: "equals", negated: true },
			],
			resourceAttributeFilters: [{ key: "b", value: "2", mode: "equals", negated: true }],
		})
	})

	it("sends nothing when there are no filters", () => {
		expect(logAttributeQueryFilters(undefined)).toEqual({
			attributeFilters: undefined,
			resourceAttributeFilters: undefined,
		})
	})
})
