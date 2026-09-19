import { describe, expect, it } from "vitest"
import { introducedVersion, versionsByRecency, type VersionRow } from "./error-versions"

const row = (serviceVersion: string, firstSeen: string, lastSeen: string, count = 1): VersionRow => ({
	serviceVersion,
	count,
	firstSeen,
	lastSeen,
})

describe("introducedVersion", () => {
	it("picks the version whose first occurrence is oldest, not the one listed first", () => {
		const rows = [
			row("1.5.0", "2026-01-02 09:00:00", "2026-01-02 10:00:00"),
			row("1.4.2", "2026-01-01 08:00:00", "2026-01-01 12:00:00"),
		]
		expect(introducedVersion(rows)).toBe("1.4.2")
	})

	it("returns null when the oldest occurrence carries no version", () => {
		// Naming the next-oldest version would assert the error started there,
		// which is precisely wrong: the unversioned rows are the earlier ones.
		const rows = [
			row("", "2026-01-01 08:00:00", "2026-01-01 09:00:00"),
			row("1.4.2", "2026-01-02 08:00:00", "2026-01-02 09:00:00"),
		]
		expect(introducedVersion(rows)).toBeNull()
	})

	it("returns null for no rows at all", () => {
		expect(introducedVersion([])).toBeNull()
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
