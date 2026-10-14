// The Logs page's URL-held state: the live-tail cadence and its hold, the
// attribute filters, and the open log. The local store is stood in for by a
// fetch stub that answers the list query with two logs and everything else empty.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { LogsView } from "./logs-view"
import { customRangeKey } from "../lib/time"

const LOG_ROWS = [
	{
		timestamp: "2026-10-14 12:00:01.000000000",
		exactTimestamp: "2026-10-14 12:00:01.000000000",
		severityText: "ERROR",
		severityNumber: 17,
		serviceName: "checkout",
		body: "payment declined",
		traceId: "",
		spanId: "",
		recordIdentity: "1",
		logAttributes: JSON.stringify({ "http.route": "/pay" }),
		resourceAttributes: JSON.stringify({ "k8s.pod.name": "checkout-1" }),
	},
	{
		timestamp: "2026-10-14 12:00:00.000000000",
		exactTimestamp: "2026-10-14 12:00:00.000000000",
		severityText: "INFO",
		severityNumber: 9,
		serviceName: "checkout",
		body: "cart loaded",
		traceId: "",
		spanId: "",
		recordIdentity: "2",
		logAttributes: "{}",
		resourceAttributes: "{}",
	},
]

/** The list (and its context / by-key lookups) select `recordIdentity`; nothing else does. */
function stubLocalStore() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
			if (!url.includes("/local/query")) return new Response("[]", { status: 200 })
			const body = typeof init?.body === "string" ? init.body : await new Request(input, init).text()
			const rows = body.includes("recordIdentity") ? LOG_ROWS : []
			return new Response(JSON.stringify(rows), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		}),
	)
}

function renderAt(hash: string) {
	window.location.hash = hash
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	render(
		<QueryClientProvider client={client}>
			<LogsView />
		</QueryClientProvider>,
	)
}

function hashQuery(): URLSearchParams {
	return new URLSearchParams(window.location.hash.split("?")[1] ?? "")
}

beforeEach(stubLocalStore)
afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
	window.location.hash = ""
})

describe("LogsView live tail", () => {
	it("reads the cadence from the URL and holds while the pointer is over the stream", async () => {
		renderAt("#/logs?range=1h&refresh=10")
		expect(await screen.findByRole("button", { name: "Auto-refresh every 10s" })).toBeDefined()
		const list = await screen.findByRole("list", { name: "Logs" })
		expect(screen.queryByText("Paused while you inspect")).toBeNull()

		fireEvent.pointerEnter(list)
		expect(await screen.findByText("Paused while you inspect")).toBeDefined()
		fireEvent.pointerLeave(list)
		await waitFor(() => expect(screen.queryByText("Paused while you inspect")).toBeNull())
	})

	it("offers no cadence over a custom range", async () => {
		const range = customRangeKey({ fromMs: Date.UTC(2026, 9, 14, 11), toMs: Date.UTC(2026, 9, 14, 13) })
		renderAt(`#/logs?range=${range}&refresh=10`)
		await screen.findByRole("list", { name: "Logs" })
		expect(screen.queryByRole("button", { name: /Auto-refresh/ })).toBeNull()
	})
})

describe("LogsView attribute filters", () => {
	it("shows each attrs entry as a removable chip", async () => {
		renderAt("#/logs?range=1h&attrs=log:http.route=/pay&attrs=!res:k8s.pod.name=checkout-1")
		await screen.findByRole("list", { name: "Logs" })
		expect(screen.getByTitle("http.route is /pay")).toBeDefined()
		expect(screen.getByTitle("k8s.pod.name (resource) is not checkout-1")).toBeDefined()

		fireEvent.click(screen.getByRole("button", { name: /Remove.*http\.route/i }))
		await waitFor(() => expect(hashQuery().getAll("attrs")).toEqual(["!res:k8s.pod.name=checkout-1"]))
	})
})

describe("LogsView open log", () => {
	it("keeps the open log in the URL and closes it from there", async () => {
		renderAt("#/logs?range=1h")
		fireEvent.click(await screen.findByRole("listitem", { name: /payment declined/ }))
		await waitFor(() => expect(hashQuery().get("log")).not.toBeNull())
		expect(await screen.findByRole("tab", { name: /Context/ })).toBeDefined()

		fireEvent.click(screen.getByRole("button", { name: "Close log details" }))
		await waitFor(() => expect(hashQuery().get("log")).toBeNull())
	})

	it("opens the drawer from a pasted link", async () => {
		renderAt("#/logs?range=1h")
		fireEvent.click(await screen.findByRole("listitem", { name: /payment declined/ }))
		await waitFor(() => expect(hashQuery().get("log")).not.toBeNull())
		const token = hashQuery().get("log") ?? ""
		cleanup()

		renderAt(`#/logs?range=1h&log=${encodeURIComponent(token)}`)
		expect(await screen.findByRole("tab", { name: /Context/ })).toBeDefined()
	})
})
