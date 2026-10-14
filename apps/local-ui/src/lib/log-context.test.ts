import { describe, expect, it } from "vitest"
import {
	contextWindows,
	decodeLogKey,
	encodeLogKey,
	instanceAttribute,
	logKeyBounds,
	logPermalink,
	matchesLogKey,
	mergeLogContext,
} from "./log-context"
import type { LocalLog } from "./log-shape"
import { parseCustomRange } from "./time"

function makeLog(timestamp: string, overrides: Partial<LocalLog> = {}): LocalLog {
	return {
		timestamp,
		severityText: "INFO",
		severityNumber: 9,
		serviceName: "api",
		body: `log at ${timestamp}`,
		traceId: "",
		spanId: "",
		recordIdentity: timestamp,
		logAttributes: {},
		resourceAttributes: {},
		...overrides,
	}
}

describe("log keys", () => {
	const log = makeLog("2026-10-14 12:00:00.123456789", {
		serviceName: "checkout é",
		traceId: "abc",
		spanId: "def",
		recordIdentity: "42",
	})

	it("round-trips a log's identity through a URL-safe token", () => {
		const token = encodeLogKey(log)
		expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
		const key = decodeLogKey(token)
		expect(key).not.toBeNull()
		expect(key && matchesLogKey(log, key)).toBe(true)
	})

	it("does not match a different record at the same instant", () => {
		const key = decodeLogKey(encodeLogKey(log))
		expect(key && matchesLogKey({ ...log, recordIdentity: "43" }, key)).toBe(false)
	})

	it("reads a malformed token as no log", () => {
		expect(decodeLogKey("not-base64!")).toBeNull()
		expect(decodeLogKey(btoa(JSON.stringify(["only", "three", "parts"])))).toBeNull()
		expect(decodeLogKey(null)).toBeNull()
	})

	it("looks the row up at exactly its stored instant", () => {
		expect(logKeyBounds(log)).toEqual({
			startTime: "2026-10-14 12:00:00.123456789",
			endTime: "2026-10-14 12:00:00.123456789",
		})
	})

	it("builds a permalink that opens the drawer over the stream around the log", () => {
		const link = logPermalink(log, "http://127.0.0.1:4319/")
		const query = new URLSearchParams(link.split("#/logs?")[1])
		expect(link.startsWith("http://127.0.0.1:4319/#/logs?")).toBe(true)
		expect(decodeLogKey(query.get("log"))).toEqual(decodeLogKey(encodeLogKey(log)))
		const window = parseCustomRange(query.get("range") ?? undefined)
		const at = Date.UTC(2026, 9, 14, 12, 0, 0, 123)
		expect(window && window.fromMs < at && window.toMs > at).toBe(true)
	})
})

describe("instanceAttribute", () => {
	it("prefers the most specific instance attribute", () => {
		expect(
			instanceAttribute({
				resourceAttributes: { "service.instance.id": "i-1", "k8s.pod.name": "web-1" },
			}),
		).toEqual({ key: "k8s.pod.name", value: "web-1" })
	})

	it("has none when the log names no instance", () => {
		expect(instanceAttribute({ resourceAttributes: { "k8s.pod.name": "" } })).toBeUndefined()
	})
})

describe("contextWindows", () => {
	it("reads an hour either side, both halves including the log's instant", () => {
		expect(contextWindows("2026-10-14 12:00:00.5")).toEqual({
			before: { startTime: "2026-10-14 11:00:00.500", endTime: "2026-10-14 12:00:00.5" },
			after: { startTime: "2026-10-14 12:00:00.5", endTime: "2026-10-14 13:00:00.500" },
		})
	})

	it("has no window for an unreadable timestamp", () => {
		expect(contextWindows("garbage")).toBeNull()
	})
})

describe("mergeLogContext", () => {
	const selected = makeLog("2026-10-14 12:00:05")
	const at = (second: number) => makeLog(`2026-10-14 12:00:0${second}`)

	it("orders neighbours oldest first around the selected log", () => {
		const merged = mergeLogContext(selected, [selected, at(4), at(3)], [selected, at(6), at(7)])
		expect(merged.map((log) => log.timestamp)).toEqual([
			"2026-10-14 12:00:03",
			"2026-10-14 12:00:04",
			"2026-10-14 12:00:05",
			"2026-10-14 12:00:06",
			"2026-10-14 12:00:07",
		])
	})

	it("keeps a row both sides returned once", () => {
		const twin = makeLog("2026-10-14 12:00:05", { recordIdentity: "twin" })
		const merged = mergeLogContext(selected, [twin, at(4)], [twin, at(6)])
		expect(merged.filter((log) => log.recordIdentity === "twin")).toHaveLength(1)
	})

	it("caps each side", () => {
		const merged = mergeLogContext(selected, [at(4), at(3), at(2)], [at(6), at(7), at(8)], 1)
		expect(merged.map((log) => log.timestamp)).toEqual([
			"2026-10-14 12:00:04",
			"2026-10-14 12:00:05",
			"2026-10-14 12:00:06",
		])
	})
})
