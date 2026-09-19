import { describe, expect, it } from "vitest"
import { layoutServiceMap, type LayoutEdge } from "./service-map-layout"

const edge = (source: string, target: string): LayoutEdge => ({ source, target })

const layerOf = (layout: ReturnType<typeof layoutServiceMap>, id: string) => layout.byId.get(id)!.layer
const rowOf = (layout: ReturnType<typeof layoutServiceMap>, id: string) => layout.byId.get(id)!.order

describe("layering", () => {
	it("puts a chain in consecutive columns", () => {
		const layout = layoutServiceMap(["a", "b", "c"], [edge("a", "b"), edge("b", "c")])
		expect([layerOf(layout, "a"), layerOf(layout, "b"), layerOf(layout, "c")]).toEqual([0, 1, 2])
	})

	// Shortest-path layering would put `b` in column 1, next to `c`, and draw
	// `c→b` backwards. Longest path is what keeps every edge pointing right.
	it("takes the longest path, so no edge points backwards", () => {
		const layout = layoutServiceMap(["a", "b", "c"], [edge("a", "b"), edge("a", "c"), edge("c", "b")])
		expect(layerOf(layout, "b")).toBe(2)
		for (const e of [edge("a", "b"), edge("a", "c"), edge("c", "b")]) {
			expect(layerOf(layout, e.source)).toBeLessThan(layerOf(layout, e.target))
		}
	})

	it("rejoins a diamond in one column", () => {
		const layout = layoutServiceMap(
			["a", "b", "c", "d"],
			[edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
		)
		expect(layerOf(layout, "b")).toBe(1)
		expect(layerOf(layout, "c")).toBe(1)
		expect(layerOf(layout, "d")).toBe(2)
	})

	it("leaves a node with no edges in the first column", () => {
		const layout = layoutServiceMap(["lonely", "a", "b"], [edge("a", "b")])
		expect(layerOf(layout, "lonely")).toBe(0)
	})

	it("ignores an edge naming a node it was not given", () => {
		const layout = layoutServiceMap(["a", "b"], [edge("a", "b"), edge("b", "ghost")])
		expect(layout.nodes).toHaveLength(2)
		expect(layerOf(layout, "b")).toBe(1)
	})

	it("lays out an empty graph without collapsing into NaN", () => {
		const layout = layoutServiceMap([], [])
		expect(layout.nodes).toEqual([])
		expect(layout.width).toBe(0)
		expect(layout.height).toBe(0)
	})
})

describe("ordering", () => {
	// `b1` is listed first but is only called by `a2`, the lower node. Barycentre
	// ordering swaps the two so the pair of edges stops crossing.
	it("orders a layer by the barycentre of its neighbours", () => {
		const layout = layoutServiceMap(["a1", "a2", "b1", "b2"], [edge("a1", "b2"), edge("a2", "b1")])
		expect(rowOf(layout, "b2")).toBeLessThan(rowOf(layout, "b1"))
	})

	it("keeps a layer's given order when nothing pulls on it", () => {
		const layout = layoutServiceMap(["a1", "a2", "b"], [edge("a1", "b"), edge("a2", "b")])
		expect(rowOf(layout, "a1")).toBe(0)
		expect(rowOf(layout, "a2")).toBe(1)
	})

	it("centres a short column against the tallest one", () => {
		const layout = layoutServiceMap(
			["a", "b1", "b2", "b3"],
			[edge("a", "b1"), edge("a", "b2"), edge("a", "b3")],
		)
		const ys = ["b1", "b2", "b3"].map((id) => layout.byId.get(id)!.y)
		expect(layout.byId.get("a")!.y).toBeCloseTo((ys[0] + ys[2]) / 2)
	})

	it("is stable across repeated runs of the same input", () => {
		const nodes = ["a", "b", "c", "d"]
		const edges = [edge("a", "c"), edge("b", "c"), edge("c", "d"), edge("a", "d")]
		expect(layoutServiceMap(nodes, edges).nodes).toEqual(layoutServiceMap(nodes, edges).nodes)
	})
})

describe("cycles", () => {
	it("breaks a two-service cycle and still lays both out", () => {
		const layout = layoutServiceMap(["a", "b"], [edge("a", "b"), edge("b", "a")])
		expect(layout.nodes).toHaveLength(2)
		expect(layout.backEdges).toEqual([{ source: "b", target: "a" }])
		expect(layerOf(layout, "a")).toBe(0)
		expect(layerOf(layout, "b")).toBe(1)
	})

	it("breaks exactly one edge of a longer cycle", () => {
		const layout = layoutServiceMap(["a", "b", "c"], [edge("a", "b"), edge("b", "c"), edge("c", "a")])
		expect(layout.backEdges).toEqual([{ source: "c", target: "a" }])
		expect([layerOf(layout, "a"), layerOf(layout, "b"), layerOf(layout, "c")]).toEqual([0, 1, 2])
	})

	it("treats a self-call as a back edge and lets it fall out of layering", () => {
		const layout = layoutServiceMap(["a", "b"], [edge("a", "a"), edge("a", "b")])
		expect(layout.backEdges).toEqual([{ source: "a", target: "a" }])
		expect(layerOf(layout, "b")).toBe(1)
	})

	it("layers every node of a graph that is nothing but a cycle", () => {
		const ids = ["a", "b", "c", "d"]
		const layout = layoutServiceMap(ids, [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "b")])
		for (const id of ids) expect(layout.byId.get(id)!.layer).toBeGreaterThanOrEqual(0)
		expect(layout.backEdges).toHaveLength(1)
		expect(layout.nodes).toHaveLength(4)
	})
})
