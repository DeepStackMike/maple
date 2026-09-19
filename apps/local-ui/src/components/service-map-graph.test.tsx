// @vitest-environment jsdom
//
// A smoke test over the drawing, not a screenshot test: the card stats, the
// edge labels and the click-to-select path are the parts that can be wrong
// while the SVG still renders, and they are all readable from the DOM.

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ServiceMapGraph } from "./service-map-graph"
import type { ServiceMapEdge, ServiceMapNode } from "../hooks/use-local-service-map"

afterEach(cleanup)

const node = (over: Partial<ServiceMapNode> & { id: string; label: string }): ServiceMapNode => ({
	kind: "service",
	serviceName: over.label,
	spanCount: 600,
	errorCount: 0,
	errorRate: 0,
	p95Ms: 20,
	avgMs: 8,
	previousP95Ms: null,
	...over,
})

const NODES: ServiceMapNode[] = [
	node({ id: "svc:checkout-api", label: "checkout-api", spanCount: 744_000 }),
	node({ id: "svc:pricing", label: "pricing", spanCount: 12_000, errorCount: 1_200, errorRate: 0.1 }),
	node({
		id: "db:postgres:orders",
		label: "orders",
		kind: "database",
		serviceName: undefined,
		dbSystem: "postgres",
		spanCount: 6_000,
		avgMs: 3,
	}),
]

const edge = (
	over: Partial<ServiceMapEdge> & { id: string; source: string; target: string },
): ServiceMapEdge => ({
	callCount: 168_000,
	errorCount: 0,
	errorRate: 0,
	avgMs: 8,
	p95Ms: 20,
	kind: "service",
	...over,
})

const EDGES: ServiceMapEdge[] = [
	edge({ id: "a", source: "svc:checkout-api", target: "svc:pricing" }),
	edge({
		id: "b",
		source: "svc:pricing",
		target: "db:postgres:orders",
		kind: "database",
		callCount: 60_000,
	}),
]

const renderGraph = (onSelectService = vi.fn()) => {
	render(
		<ServiceMapGraph
			nodes={NODES}
			edges={EDGES}
			maxCallCount={168_000}
			windowSeconds={60}
			onSelectService={onSelectService}
		/>,
	)
	return onSelectService
}

describe("service map graph", () => {
	it("gives every node a card with its per-second rate", () => {
		renderGraph()
		// 744,000 spans over a 60 s window is 12.4k/s — the whole point of the
		// window being a number rather than a label.
		expect(screen.getByText("12.4k")).toBeDefined()
		expect(screen.getAllByText("Req/s").length).toBe(2)
	})

	it("labels a database with its own columns and a DB tag", () => {
		renderGraph()
		expect(screen.getByText("DB")).toBeDefined()
		expect(screen.getByText("Calls/s")).toBeDefined()
		// A database has no error column: the calls that failed are on the edge.
		expect(screen.getAllByText("Errs").length).toBe(2)
	})

	it("shows the error share and the mean latency on the card", () => {
		renderGraph()
		expect(screen.getByText("10.0%")).toBeDefined()
		expect(screen.getAllByText("8.0ms").length).toBeGreaterThan(0)
	})

	it("labels the busiest edges with a rate", () => {
		renderGraph()
		expect(screen.getByText("2.8k req/s")).toBeDefined()
		expect(screen.getByText("1.0k calls/s")).toBeDefined()
	})

	it("selects a node on click and opens the service from its card", () => {
		const onSelectService = renderGraph()
		const card = screen.getByRole("button", { name: /^pricing:/ })
		expect(card.getAttribute("aria-pressed")).toBe("false")
		fireEvent.click(card)
		expect(card.getAttribute("aria-pressed")).toBe("true")

		fireEvent.click(screen.getByRole("button", { name: /Open service/ }))
		expect(onSelectService).toHaveBeenCalledWith("pricing")
	})

	it("opens the service on a double-click", () => {
		const onSelectService = renderGraph()
		fireEvent.doubleClick(screen.getByRole("button", { name: /^checkout-api:/ }))
		expect(onSelectService).toHaveBeenCalledWith("checkout-api")
	})

	it("animates the flow dots along the very path the edge was drawn with", () => {
		const { container } = render(
			<ServiceMapGraph
				nodes={NODES}
				edges={EDGES}
				maxCallCount={168_000}
				windowSeconds={60}
				onSelectService={vi.fn()}
			/>,
		)
		const motions = [...container.querySelectorAll("animateMotion")]
		expect(motions.length).toBeGreaterThan(0)
		const paths = new Set([...container.querySelectorAll("path[stroke]")].map((p) => p.getAttribute("d")))
		for (const motion of motions) {
			expect(motion.getAttribute("repeatCount")).toBe("indefinite")
			expect(paths.has(motion.getAttribute("path"))).toBe(true)
		}
	})
})
