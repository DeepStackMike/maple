// Reading a fingerprint's per-build occurrence split.
//
// `errorVersionsQuery` returns one row per (fingerprint, version) over the
// selected window, and the two things the Errors page asks of that shape are
// both one-liners with one trap each — so they live here, where a test can hold
// them, rather than inline in a table cell.

/** One `(fingerprint, version)` group, as `CH.ErrorVersionsOutput` gives it. */
export interface VersionRow {
	readonly serviceVersion: string
	readonly count: number
	readonly firstSeen: string
	readonly lastSeen: string
}

/**
 * The build this error first appeared on *inside the selected window*.
 *
 * Deliberately not "the build it was introduced in" without qualification: the
 * window is a window, and the earliest row in a one-hour range says nothing
 * about last week. The caller is responsible for saying so; this only picks the
 * row.
 *
 * `null` when the earliest occurrence carries no version at all — an exporter
 * that never set `service.version`. Naming the *next*-oldest version instead
 * would be a guess dressed as a fact, and the guess is wrong in exactly the
 * case that matters (the unversioned rows are the older ones).
 */
export function introducedVersion(rows: ReadonlyArray<VersionRow>): string | null {
	let earliest: VersionRow | undefined
	for (const row of rows) {
		if (!earliest || row.firstSeen < earliest.firstSeen) earliest = row
	}
	return earliest?.serviceVersion || null
}

/**
 * Versions for display: most recently active first.
 *
 * Ties break on count, then on version string, so two builds whose last
 * occurrence landed in the same second do not swap places between renders —
 * `Array#sort` is stable but the input order is a SQL `ORDER BY` over values
 * that change as data arrives.
 */
export function versionsByRecency<T extends VersionRow>(rows: ReadonlyArray<T>): Array<T> {
	return [...rows].sort(
		(a, b) =>
			b.lastSeen.localeCompare(a.lastSeen) ||
			b.count - a.count ||
			a.serviceVersion.localeCompare(b.serviceVersion),
	)
}
