import { describe, expect, it } from "vitest"
import {
	compareErrorVersions,
	introducedIn,
	nothingCompared,
	predecessorOf,
	versionsByRecency,
	type ComparedVersion,
	type ErrorSlice,
	type VersionRow,
	type VersionTraffic,
} from "./error-versions"

const row = (serviceVersion: string, firstSeen: string, lastSeen: string, count = 1): VersionRow => ({
	serviceVersion,
	count,
	firstSeen,
	lastSeen,
})

const API = "api"
const PROD = "production"

const traffic = (
	version: string,
	firstSeen: string,
	spanCount = 1000,
	serviceName = API,
	environment = PROD,
): VersionTraffic => ({ serviceName, environment, version, spanCount, firstSeen, lastSeen: firstSeen })

const slice = (serviceVersion: string, count: number, serviceName = API, environment = PROD): ErrorSlice => ({
	serviceName,
	environment,
	serviceVersion,
	count,
	firstSeen: "2026-01-01 00:00:00",
	lastSeen: "2026-01-01 00:00:00",
})

const byVersion = (rows: ReadonlyArray<ComparedVersion>, version: string) =>
	rows.find((r) => r.serviceVersion === version)?.comparison

describe("predecessorOf", () => {
	it("is the latest version first seen strictly earlier on the same service and environment", () => {
		const rows = [
			traffic("1.0.0", "2026-01-01 08:00:00"),
			traffic("1.1.0", "2026-01-01 09:00:00"),
			traffic("1.2.0", "2026-01-01 10:00:00"),
			traffic("9.9.9", "2026-01-01 09:30:00", 1000, "web"),
			traffic("8.8.8", "2026-01-01 09:45:00", 1000, API, "staging"),
		]
		expect(predecessorOf(rows[2], rows)?.version).toBe("1.1.0")
		expect(predecessorOf(rows[1], rows)?.version).toBe("1.0.0")
		expect(predecessorOf(rows[0], rows)).toBeUndefined()
	})

	it("leaves versions first seen in the same second unordered", () => {
		const rows = [
			traffic("1.0.0", "2026-01-01 08:00:00"),
			traffic("1.1.0", "2026-01-01 09:00:00.120", 10),
			traffic("1.2.0", "2026-01-01 09:00:00.950", 5000),
		]
		expect(predecessorOf(rows[1], rows)?.version).toBe("1.0.0")
		expect(predecessorOf(rows[2], rows)?.version).toBe("1.0.0")
	})
})

describe("compareErrorVersions", () => {
	it("calls an error new when the version it replaced never had it", () => {
		const t = [traffic("1.0.0", "2026-01-01 08:00:00"), traffic("1.1.0", "2026-01-01 09:00:00")]
		const c = byVersion(compareErrorVersions([slice("1.1.0", 30)], t), "1.1.0")
		expect(c?.kind).toBe("compared")
		if (c?.kind !== "compared") return
		expect(c.verdict).toBe("new")
		expect(c.ratio).toBeNull()
		expect(c.baseline.version).toBe("1.0.0")
		expect(c.baseline.errorCount).toBe(0)
	})

	it("compares against the previous version only, not every older one", () => {
		const t = [
			traffic("1.0.0", "2026-01-01 08:00:00"),
			traffic("1.1.0", "2026-01-01 09:00:00"),
			traffic("1.2.0", "2026-01-01 10:00:00"),
		]
		const rows = compareErrorVersions([slice("1.0.0", 400), slice("1.1.0", 3), slice("1.2.0", 3)], t)
		const newest = byVersion(rows, "1.2.0")
		if (newest?.kind !== "compared") throw new Error("expected a comparison")
		expect(newest.baseline.version).toBe("1.1.0")
		expect(newest.ratio).toBeCloseTo(1, 3)
		expect(newest.verdict).toBe("similar")
		const middle = byVersion(rows, "1.1.0")
		if (middle?.kind !== "compared") throw new Error("expected a comparison")
		expect(middle.verdict).toBe("fewer")
	})

	it("rates each side over its own traffic", () => {
		// Same count, a tenth of the traffic: ten times the rate.
		const t = [
			traffic("1.0.0", "2026-01-01 08:00:00", 1000),
			traffic("1.1.0", "2026-01-01 09:00:00", 100),
		]
		const c = byVersion(compareErrorVersions([slice("1.0.0", 10), slice("1.1.0", 10)], t), "1.1.0")
		if (c?.kind !== "compared") throw new Error("expected a comparison")
		expect(c.ratio).toBeCloseTo(10, 3)
		expect(c.verdict).toBe("more")
	})

	it("does not call a doubling of a negligible rate more", () => {
		const t = [
			traffic("1.0.0", "2026-01-01 08:00:00", 10_000),
			traffic("1.1.0", "2026-01-01 09:00:00", 10_000),
		]
		const c = byVersion(compareErrorVersions([slice("1.0.0", 1), slice("1.1.0", 3)], t), "1.1.0")
		if (c?.kind !== "compared") throw new Error("expected a comparison")
		expect(c.verdict).toBe("similar")
	})

	it("says why nothing was compared", () => {
		const t = [traffic("1.0.0", "2026-01-01 08:00:00"), traffic("1.1.0", "2026-01-01 09:00:00", 10)]
		const rows = compareErrorVersions(
			[slice("1.0.0", 5), slice("1.1.0", 5), slice("", 2), slice("2.0.0", 1)],
			t,
		)
		expect(byVersion(rows, "1.0.0")).toEqual({
			kind: "not-compared",
			reason: "oldest",
			baselineVersion: undefined,
		})
		expect(byVersion(rows, "1.1.0")).toEqual({
			kind: "not-compared",
			reason: "low-traffic",
			baselineVersion: "1.0.0",
		})
		expect(byVersion(rows, "")).toMatchObject({ reason: "unversioned" })
		expect(byVersion(rows, "2.0.0")).toMatchObject({ reason: "no-traffic" })
		expect(nothingCompared(rows)).toBe(true)
	})

	it("keeps service and environment apart", () => {
		const t = [
			traffic("1.0.0", "2026-01-01 08:00:00", 1000, API, "staging"),
			traffic("1.1.0", "2026-01-01 09:00:00", 1000, API, PROD),
		]
		const c = byVersion(compareErrorVersions([slice("1.1.0", 5)], t), "1.1.0")
		expect(c).toMatchObject({ kind: "not-compared", reason: "oldest" })
	})
})

describe("introducedIn", () => {
	it("names the version an error arrived on, against the one it replaced", () => {
		const t = [
			traffic("1.0.0", "2026-01-01 08:00:00"),
			traffic("1.1.0", "2026-01-01 09:00:00"),
			traffic("1.2.0", "2026-01-01 10:00:00"),
		]
		const rows = compareErrorVersions([slice("1.2.0", 9), slice("1.1.0", 4)], t)
		expect(introducedIn(rows, t)).toEqual({
			kind: "introduced",
			version: "1.1.0",
			baselineVersion: "1.0.0",
		})
	})

	it("does not claim an introduction on the oldest version in the window", () => {
		const t = [traffic("1.0.0", "2026-01-01 08:00:00"), traffic("1.1.0", "2026-01-01 09:00:00")]
		const rows = compareErrorVersions([slice("1.0.0", 4), slice("1.1.0", 4)], t)
		expect(introducedIn(rows, t)).toMatchObject({
			kind: "first-seen",
			version: "1.0.0",
			reason: "oldest",
		})
	})

	it("orders by the version's own first span, not the error's", () => {
		const t = [traffic("1.0.0", "2026-01-01 08:00:00"), traffic("1.1.0", "2026-01-01 09:00:00")]
		const early = { ...slice("1.1.0", 4), firstSeen: "2025-12-31 00:00:00" }
		const late = { ...slice("1.0.0", 4), firstSeen: "2026-01-02 00:00:00" }
		const rows = compareErrorVersions([early, late], t)
		expect(introducedIn(rows, t)?.version).toBe("1.0.0")
	})

	it("is null when no slice carries a version", () => {
		expect(introducedIn(compareErrorVersions([slice("", 3)], []), [])).toBeNull()
		expect(introducedIn([], [])).toBeNull()
	})
})

describe("versionsByRecency", () => {
	it("orders by last occurrence, newest first", () => {
		const rows = [
			row("1.4.2", "2026-01-01 08:00:00", "2026-01-01 12:00:00"),
			row("1.5.0", "2026-01-02 09:00:00", "2026-01-02 10:00:00"),
		]
		expect(versionsByRecency(rows).map((r) => r.serviceVersion)).toEqual(["1.5.0", "1.4.2"])
	})

	it("breaks a tied lastSeen deterministically rather than leaving input order", () => {
		const a = [
			row("1.4.2", "2026-01-01 08:00:00", "2026-01-02 10:00:00", 3),
			row("1.5.0", "2026-01-02 09:00:00", "2026-01-02 10:00:00", 9),
		]
		const b = [a[1], a[0]]
		expect(versionsByRecency(a)).toEqual(versionsByRecency(b))
		expect(versionsByRecency(a).map((r) => r.serviceVersion)).toEqual(["1.5.0", "1.4.2"])
	})

	it("does not mutate its input", () => {
		const rows = [
			row("1.4.2", "2026-01-01 08:00:00", "2026-01-01 12:00:00"),
			row("1.5.0", "2026-01-02 09:00:00", "2026-01-02 10:00:00"),
		]
		versionsByRecency(rows)
		expect(rows.map((r) => r.serviceVersion)).toEqual(["1.4.2", "1.5.0"])
	})
})
