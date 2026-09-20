// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { afterEach, describe, expect, it } from "vitest"
import type { SessionEvent } from "../events/events-sink"
import { setActiveTraceIdProvider } from "../events/trace-id"
import { installNetworkCapture, isNetworkCaptureInstalled } from "./network"

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"

/**
 * Stands in for OTel's `FetchInstrumentation`: it wraps `window.fetch`, opens a
 * span around the request, and the span is active only *inside* that wrapper —
 * which is the whole reason installation order decides whether the capture sees
 * a trace id.
 */
function installFakeInstrumentation(): () => void {
	const inner = window.fetch
	let activeSpanTraceId: string | undefined
	setActiveTraceIdProvider(() => activeSpanTraceId)
	const wrapped: typeof window.fetch = async (input, init) => {
		activeSpanTraceId = TRACE_ID
		try {
			return await inner(input, init)
		} finally {
			activeSpanTraceId = undefined
		}
	}
	window.fetch = wrapped
	return () => {
		if (window.fetch === wrapped) window.fetch = inner
		setActiveTraceIdProvider(() => undefined)
	}
}

const noIgnore = (): boolean => false

afterEach(() => {
	setActiveTraceIdProvider(() => undefined)
})

describe("network capture trace ids", () => {
	it("stamps the trace id of the span the tracing instrumentation opens around the request", async () => {
		const events: SessionEvent[] = []
		const origFetch = window.fetch
		window.fetch = async () => new Response(null, { status: 204 })
		// Install order matters: the capture goes on first so the instrumentation
		// wraps *it*, leaving the capture running inside the request's span.
		const stopCapture = installNetworkCapture((ev) => events.push(ev), noIgnore)
		const stopInstrumentation = installFakeInstrumentation()

		await window.fetch("https://api.example.com/widgets")

		expect(events).toHaveLength(1)
		expect(events[0]?.type).toBe("network")
		expect(events[0]?.traceId).toBe(TRACE_ID)

		stopInstrumentation()
		stopCapture()
		window.fetch = origFetch
	})

	it("keeps the first (innermost) capture and makes a later install a no-op", async () => {
		const first: SessionEvent[] = []
		const second: SessionEvent[] = []
		const origFetch = window.fetch
		window.fetch = async () => new Response(null, { status: 200 })
		const stopFirst = installNetworkCapture((ev) => first.push(ev), noIgnore)
		const stopInstrumentation = installFakeInstrumentation()
		// The lazily-imported replay chunk installing its own capture must not
		// wrap the instrumentation (that wrapper would see no active span) and
		// must not double-count the request.
		const stopSecond = installNetworkCapture((ev) => second.push(ev), noIgnore)
		expect(isNetworkCaptureInstalled()).toBe(true)

		await window.fetch("https://api.example.com/widgets")

		expect(second).toHaveLength(0)
		expect(first).toHaveLength(1)
		expect(first[0]?.traceId).toBe(TRACE_ID)

		stopSecond()
		stopInstrumentation()
		stopFirst()
		window.fetch = origFetch
	})

	it("restores fetch and XHR, and releases the install flag, on uninstall", async () => {
		const origFetch = window.fetch
		const origOpen = XMLHttpRequest.prototype.open
		const origSend = XMLHttpRequest.prototype.send
		const stop = installNetworkCapture(() => {}, noIgnore)
		expect(window.fetch).not.toBe(origFetch)

		stop()

		expect(window.fetch).toBe(origFetch)
		expect(XMLHttpRequest.prototype.open).toBe(origOpen)
		expect(XMLHttpRequest.prototype.send).toBe(origSend)
		expect(isNetworkCaptureInstalled()).toBe(false)
	})

	it("leaves an outer tracing patch intact when it uninstalls out of order", async () => {
		const events: SessionEvent[] = []
		const origFetch = window.fetch
		window.fetch = async () => new Response(null, { status: 200 })
		const stopCapture = installNetworkCapture((ev) => events.push(ev), noIgnore)
		const stopInstrumentation = installFakeInstrumentation()

		// Tearing the capture down first must not rip the instrumentation's
		// wrapper off the page; it only goes inert.
		stopCapture()
		const res = await window.fetch("https://api.example.com/widgets")

		expect(res.status).toBe(200)
		expect(events).toHaveLength(0)
		// The instrumentation restores what it wrapped — the now-inert capture —
		// so requests keep working and still emit nothing.
		stopInstrumentation()
		expect((await window.fetch("https://api.example.com/widgets")).status).toBe(200)
		expect(events).toHaveLength(0)
		window.fetch = origFetch
	})
})
