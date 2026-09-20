import { type Emit, safeEmit } from "./shared"
import { activeTraceId } from "../events/trace-id"

/**
 * One installation per page, published on `globalThis` for the same reason the
 * sink is: an app can end up with two bundled copies of this module (the
 * always-loaded tier plus a lazily-imported replay chunk), and each copy would
 * otherwise wrap `window.fetch` again and emit a duplicate row per request.
 *
 * First install wins, and that ordering is load-bearing rather than arbitrary:
 * whoever wraps `window.fetch` **last** is the *outer* wrapper, and only the
 * innermost one runs inside the active span OTel's `FetchInstrumentation`
 * creates around the request. A capture installed after the instrumentation
 * reads `activeTraceId()` with no span active and stamps every network row
 * `trace_id: ""`. Hosts therefore install this before they set up tracing; a
 * later install from the replay chunk is a no-op that keeps the early,
 * correctly-nested wrapper in place.
 */
const INSTALLED_KEY = "__MAPLE_NETWORK_CAPTURE_INSTALLED__"

function installedFlag(): Record<string, boolean | undefined> {
	return globalThis as typeof globalThis & Record<string, boolean | undefined>
}

/** True when a network capture already owns the `fetch`/XHR patches. */
export function isNetworkCaptureInstalled(): boolean {
	return installedFlag()[INSTALLED_KEY] === true
}

/**
 * Capture fetch + XHR requests as session events, tagged with the active trace
 * id so each request links to its backend trace. `ignoreUrl` skips Maple's own
 * ingest endpoints (otherwise capturing the session-events POST would loop).
 */
export function installNetworkCapture(emit: Emit, ignoreUrl: (url: string) => boolean): () => void {
	if (isNetworkCaptureInstalled()) return () => {}
	installedFlag()[INSTALLED_KEY] = true
	let stopped = false
	const origFetch = typeof window !== "undefined" ? window.fetch : undefined
	let patchedFetch: typeof window.fetch | undefined

	if (origFetch) {
		patchedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			if (stopped) return origFetch(input, init)
			const url = requestUrl(input)
			const method = requestMethod(input, init)
			const traceId = activeTraceId()
			const start = performance.now()
			try {
				const res = await origFetch(input, init)
				record(url, method, res.status, start, traceId)
				return res
			} catch (error) {
				record(url, method, 0, start, traceId, String(error))
				throw error
			}
		}
		window.fetch = patchedFetch
	}

	const record = (
		url: string,
		method: string,
		status: number,
		start: number,
		traceId: string | undefined,
		error?: string,
	): void => {
		if (ignoreUrl(url)) return
		safeEmit(emit, {
			type: "network",
			net: { method, url, status, durationMs: Math.round(performance.now() - start) },
			traceId,
			...(error ? { attrs: { error } } : undefined),
		})
	}

	// XMLHttpRequest — patch open (to capture method/url) + send (to time + observe).
	const XHR = typeof window !== "undefined" ? window.XMLHttpRequest : undefined
	const origOpen = XHR?.prototype.open
	const origSend = XHR?.prototype.send
	if (XHR && origOpen && origSend) {
		XHR.prototype.open = function (
			this: XMLHttpRequest,
			method: string,
			url: string | URL,
			...rest: unknown[]
		) {
			;(this as XhrMeta).__mapleMethod = String(method).toUpperCase()
			;(this as XhrMeta).__mapleUrl = typeof url === "string" ? url : url.href
			return origOpen.apply(this, [method, url, ...rest] as never)
		}
		XHR.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
			if (stopped) return origSend.apply(this, args as never)
			const meta = this as XhrMeta
			const start = performance.now()
			const traceId = activeTraceId()
			this.addEventListener("loadend", () => {
				record(meta.__mapleUrl ?? "", meta.__mapleMethod ?? "GET", this.status, start, traceId)
			})
			return origSend.apply(this, args as never)
		}
	}

	const patchedOpen = XHR?.prototype.open
	const patchedSend = XHR?.prototype.send

	return () => {
		if (stopped) return
		stopped = true
		installedFlag()[INSTALLED_KEY] = undefined
		// Restore only what is still ours. A tracing instrumentation installed
		// *after* this capture wrapped `window.fetch` holds our wrapper as its
		// "original", so blindly writing `origFetch` back would tear that
		// instrumentation's patch off with it. When we are no longer the outermost
		// wrapper the `stopped` flag above makes ours an inert pass-through, and
		// the instrumentation restores the native function when it shuts down.
		if (origFetch && window.fetch === patchedFetch) window.fetch = origFetch
		if (XHR && origOpen && XHR.prototype.open === patchedOpen) XHR.prototype.open = origOpen
		if (XHR && origSend && XHR.prototype.send === patchedSend) XHR.prototype.send = origSend
	}
}

interface XhrMeta extends XMLHttpRequest {
	__mapleMethod?: string
	__mapleUrl?: string
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input
	if (input instanceof URL) return input.href
	return input.url
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
	const m = init?.method ?? (typeof input === "object" && "method" in input ? input.method : undefined)
	return (m ?? "GET").toUpperCase()
}
