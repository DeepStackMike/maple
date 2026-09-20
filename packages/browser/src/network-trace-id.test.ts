// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { clearSessionSink, resetConsentForTests, setConsent } from "@maple/browser-session"
import { afterEach, describe, expect, it, vi } from "vitest"

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"

/**
 * Stands in for the OTel tracing setup: `setupTracing` registers
 * `FetchInstrumentation`, which wraps `window.fetch` and opens a span that is
 * active only *inside* that wrapper. The session sink's active-trace-id
 * provider is wired to it exactly as the real `init` wires
 * `trace.getActiveSpan()`.
 */
const tracing = vi.hoisted(() => ({ uninstall: undefined as (() => void) | undefined }))
vi.mock("./tracing", async () => {
	const { setActiveTraceIdProvider } = await import("@maple/browser-session")
	return {
		setupTracing: () => {
			const inner = window.fetch
			let activeSpanTraceId: string | undefined
			setActiveTraceIdProvider(() => activeSpanTraceId)
			window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				activeSpanTraceId = TRACE_ID
				try {
					return await inner(input, init)
				} finally {
					activeSpanTraceId = undefined
				}
			}) as typeof window.fetch
			tracing.uninstall = () => setActiveTraceIdProvider(() => undefined)
			return async () => {
				tracing.uninstall?.()
			}
		},
	}
})

// The replay chunk is stubbed out: the network capture must be installed by
// `init` itself, before tracing, rather than riding in on the lazy chunk.
vi.mock("@maple/browser-session/replay", () => ({
	startReplaySession: () => ({ sessionId: "replay-session", shutdown: async () => {} }),
}))

import { resetSinkForTests } from "../../browser-session/src/events/events-sink"
import { init } from "./init"

class MemoryStorage {
	private readonly values = new Map<string, string>()
	getItem(key: string): string | null {
		return this.values.get(key) ?? null
	}
	setItem(key: string, value: string): void {
		this.values.set(key, value)
	}
	removeItem(key: string): void {
		this.values.delete(key)
	}
}

afterEach(() => {
	setConsent(false)
	resetConsentForTests()
	resetSinkForTests()
	clearSessionSink()
	tracing.uninstall?.()
	tracing.uninstall = undefined
	vi.unstubAllGlobals()
})

interface EventRow {
	type: string
	trace_id: string
	net_url: string
}

describe("network session events", () => {
	it("carries the trace id of the span the fetch instrumentation opened", async () => {
		const rows: EventRow[] = []
		// Ingest posts ride the global `fetch`; the app's requests go through
		// `window.fetch`, which is what both the capture and the instrumentation
		// wrap.
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
			if (url.includes("/v1/sessionEvents") && typeof init?.body === "string") {
				// SAFETY: the body is the NDJSON this very SDK just serialized from
				// `toRow`, so each line decodes to the row shape asserted below.
				rows.push(
					...init.body
						.split("\n")
						.filter((line) => line !== "")
						.map((line) => JSON.parse(line) as EventRow),
				)
			}
			return new Response(null, { status: 200 })
		})
		vi.stubGlobal("window", {
			sessionStorage: new MemoryStorage(),
			localStorage: new MemoryStorage(),
			location: { href: "https://app.example.com/", host: "app.example.com" },
			fetch: async () => new Response(null, { status: 204 }),
		})

		const handle = init({
			ingestKey: "public-key",
			serviceName: "test-web",
			endpoint: "https://collector.test",
			tracing: { enabled: true },
			replay: { enabled: true, sampleRate: 1 },
		})

		await window.fetch("https://api.example.com/widgets")
		await handle.shutdown()

		const network = rows.filter((row) => row.type === "network")
		expect(network).toHaveLength(1)
		expect(network[0]?.net_url).toBe("https://api.example.com/widgets")
		// The bug: installed after the instrumentation, the capture read the
		// active trace id from outside the span and every row landed with "".
		expect(network[0]?.trace_id).toBe(TRACE_ID)
	})
})
