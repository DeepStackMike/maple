import { skipToken } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import {
	ALL_PROJECTS_SCOPE,
	matchesNothing,
	projectKey,
	scopedPlaceholder,
	scopedQueryFn,
	scopeServiceMap,
	scopeServices,
	withinProject,
} from "./project-scope"

describe("scopeServices", () => {
	it("is the page filter alone with no project", () => {
		expect(scopeServices(undefined, undefined)).toBeUndefined()
		expect(scopeServices(undefined, "api")).toEqual(["api"])
		expect(scopeServices(undefined, [])).toBeUndefined()
	})

	it("is the project alone with no page filter", () => {
		expect(scopeServices(["api", "web"], undefined)).toEqual(["api", "web"])
		expect(scopeServices([], undefined)).toEqual([])
	})

	it("intersects the two", () => {
		expect(scopeServices(["api", "web"], "api")).toEqual(["api"])
		expect(scopeServices(["api", "web"], ["web", "worker"])).toEqual(["web"])
	})

	it("yields nothing for a page service outside the project", () => {
		expect(scopeServices(["api", "web"], "reef-dash-mobile")).toEqual([])
	})
})

describe("matchesNothing", () => {
	it("tells an empty project apart from no project", () => {
		expect(matchesNothing(undefined)).toBe(false)
		expect(matchesNothing([])).toBe(true)
		expect(matchesNothing(["api"])).toBe(false)
	})
})

describe("withinProject", () => {
	const options = [
		{ name: "api", count: 3 },
		{ name: "reef-dash-mobile", count: 9 },
	]

	it("keeps only the project's options", () => {
		expect(withinProject(options, ["api"])).toEqual([{ name: "api", count: 3 }])
		expect(withinProject(options, [])).toEqual([])
	})

	it("passes everything through with no project", () => {
		expect(withinProject(options, undefined)).toBe(options)
	})
})

describe("scopeServiceMap", () => {
	const data = {
		edges: [
			{ sourceService: "shop-web", targetService: "shop-api" },
			{ sourceService: "shop-api", targetService: "auth" },
			{ sourceService: "reef-web", targetService: "reef-api" },
			{ sourceService: "shop-api", targetService: "stripe" },
		],
		dbEdges: [{ sourceService: "shop-api" }, { sourceService: "reef-api" }],
		overviews: [
			{ serviceName: "shop-web", environment: "production" },
			{ serviceName: "shop-api", environment: "production" },
			{ serviceName: "shop-api", environment: "staging" },
			{ serviceName: "auth", environment: "production" },
			{ serviceName: "reef-web", environment: "staging" },
			{ serviceName: "reef-api", environment: "staging" },
		],
		platforms: new Map(),
	}

	it("returns the data untouched with no scope", () => {
		expect(scopeServiceMap(data, { services: undefined, environment: undefined })).toBe(data)
	})

	it("keeps an edge when either end is in the project", () => {
		const scoped = scopeServiceMap(data, { services: ["shop-web", "shop-api"], environment: undefined })
		expect(scoped.edges.map((e) => `${e.sourceService}>${e.targetService}`)).toEqual([
			"shop-web>shop-api",
			"shop-api>auth",
			"shop-api>stripe",
		])
		expect(scoped.overviews.map((o) => o.serviceName)).toEqual(["shop-web", "shop-api", "shop-api"])
		expect(scoped.dbEdges).toEqual([{ sourceService: "shop-api" }])
		expect(scoped.platforms).toBe(data.platforms)
	})

	it("narrows overviews by environment and prunes edges by their ends", () => {
		const scoped = scopeServiceMap(data, { services: undefined, environment: "staging" })
		expect(scoped.overviews.map((o) => o.serviceName)).toEqual(["shop-api", "reef-web", "reef-api"])
		// shop-web and auth never reported in staging; stripe never reported at
		// all, so it does not veto the edge it ends.
		expect(scoped.edges.map((e) => `${e.sourceService}>${e.targetService}`)).toEqual([
			"reef-web>reef-api",
			"shop-api>stripe",
		])
		expect(scoped.dbEdges).toEqual([{ sourceService: "shop-api" }, { sourceService: "reef-api" }])
	})

	it("applies both at once", () => {
		const scoped = scopeServiceMap(data, { services: ["shop-api"], environment: "staging" })
		expect(scoped.overviews).toEqual([{ serviceName: "shop-api", environment: "staging" }])
		expect(scoped.edges.map((e) => `${e.sourceService}>${e.targetService}`)).toEqual(["shop-api>stripe"])
	})

	it("draws nothing for an empty project", () => {
		const scoped = scopeServiceMap(data, { services: [], environment: undefined })
		expect(scoped.edges).toEqual([])
		expect(scoped.overviews).toEqual([])
		expect(scoped.dbEdges).toEqual([])
	})
})

describe("scoped queries", () => {
	const fn = async () => 1

	it("skips while the project's services are pending", () => {
		expect(scopedQueryFn({ isPending: true }, fn)).toBe(skipToken)
		expect(scopedQueryFn({ isPending: false }, fn)).toBe(fn)
		expect(scopedQueryFn({ isPending: false }, false)).toBe(skipToken)
	})

	it("keeps previous data only from the same project", () => {
		const shop = { namespace: "shop", services: ["api"], isPending: false, error: null }
		const keyOf = (scope: typeof shop | typeof ALL_PROJECTS_SCOPE) => ["local", "x", projectKey(scope)]
		const placeholder = scopedPlaceholder(shop)

		expect(placeholder("rows", { queryKey: keyOf(shop) })).toBe("rows")
		expect(placeholder("rows", { queryKey: keyOf(ALL_PROJECTS_SCOPE) })).toBeUndefined()
		expect(placeholder("rows", { queryKey: keyOf({ ...shop, namespace: "reef" }) })).toBeUndefined()
		expect(placeholder("rows", undefined)).toBeUndefined()
		expect(
			scopedPlaceholder({ ...shop, isPending: true })("rows", { queryKey: keyOf(shop) }),
		).toBeUndefined()
		expect(scopedPlaceholder(ALL_PROJECTS_SCOPE)("rows", { queryKey: keyOf(ALL_PROJECTS_SCOPE) })).toBe(
			"rows",
		)
	})
})
