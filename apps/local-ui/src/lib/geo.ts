// Visitor geography, as a reader places it on a map.
//
// Two sources, and the split is the ingest sidecar's: `session_replays.Country`
// is one ISO 3166-1 alpha-2 code resolved from an edge header, and everything
// finer — `geo.region.iso_code`, `geo.region.name`, `geo.locality.name` — is
// written into the session's `ResourceAttributes` under the OpenTelemetry keys.
//
// Codes are what the warehouse groups by; names are what a reader can place.
// `PR-127` is a real ISO 3166-2 subdivision and nobody knows which one, so the
// name wins wherever the sidecar resolved one and the code survives in a
// tooltip — dropping it would make the row unsearchable against the raw data.

const ISO_COUNTRY = /^[A-Za-z]{2}$/

let regionNames: Intl.DisplayNames | undefined | null = null

/**
 * `DE` → `Germany`, `undefined` for anything that is not a country this
 * runtime's CLDR table knows.
 *
 * `Intl.DisplayNames` is the whole implementation: the browser already ships
 * the region table, and our own map would be a few KB that goes stale. Pinned
 * to English rather than the visitor's locale — this names *the visited site's*
 * traffic, and a dashboard whose country column changes spelling with the
 * operator's OS setting cannot be compared across two screenshots. Constructed
 * once, because constructing one per row is the expensive part, and inside a
 * `try` because a runtime without the constructor must degrade to the bare code
 * rather than throw through the render.
 */
export function countryName(code: string | null | undefined): string | undefined {
	if (!code || !ISO_COUNTRY.test(code)) return undefined
	if (regionNames === null) {
		try {
			regionNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" })
		} catch {
			regionNames = undefined
		}
	}
	return regionNames?.of(code.toUpperCase())
}

/**
 * `DE` → `🇩🇪`, by the regional-indicator pairs the emoji flags are built from
 * (`A` → U+1F1E6). Two-letter A–Z only: every other value — `''`, a region
 * code, a name the gateway let through — would render as an unrelated pair of
 * letter blocks rather than as nothing, which is the failure worth avoiding.
 */
export function flagEmoji(code: string | null | undefined): string | undefined {
	if (!code || !ISO_COUNTRY.test(code)) return undefined
	return String.fromCodePoint(
		...[...code.toUpperCase()].map((char) => 0x1f1e6 + (char.charCodeAt(0) - "A".charCodeAt(0))),
	)
}

/** `DE` → `🇩🇪 Germany`, falling back to the value itself for anything else. */
export function countryLabel(code: string): string {
	return [flagEmoji(code), countryName(code) ?? code].filter(Boolean).join(" ")
}

/** What the sidecar resolved, in the spellings it writes. */
export interface LocationParts {
	/** ISO 3166-1 alpha-2, from the `Country` column or `geo.country.iso_code`. */
	readonly country?: string | null
	/** ISO 3166-2 subdivision WITHOUT the country prefix — `TX`, `127`. */
	readonly regionCode?: string | null
	/** The subdivision's plain name — `Texas`, `San Juan`. */
	readonly regionName?: string | null
	/** `geo.locality.name`. */
	readonly city?: string | null
}

export interface FormattedLocation {
	/** Regional-indicator flag, present only for a two-letter country code. */
	readonly flag?: string
	/** "City, Region, Country" over whichever of the three resolved. */
	readonly label: string
	/**
	 * The ISO 3166-2 code the region name in `label` stands in for, qualified by
	 * its country (`US-TX`) — a subdivision code is unique only inside one.
	 * Unset when the label already shows the code, or when there is no region.
	 */
	readonly title?: string
}

/**
 * Fold the parts into one line, skipping whatever the sidecar could not
 * resolve, and `undefined` when it resolved nothing at all.
 *
 * Coarsest-last ("Austin, Texas, United States") because that is how every
 * postal address and every analytics product orders it, and because the two
 * halves of a partial answer then still read in the same direction: a session
 * with only a country is the tail of the same sentence, not a different one.
 */
export function formatLocation(parts: LocationParts): FormattedLocation | undefined {
	const country = clean(parts.country)
	const regionCode = clean(parts.regionCode)
	const regionName = clean(parts.regionName)
	const city = clean(parts.city)

	const label = [city, regionName ?? regionCode, countryName(country) ?? country]
		.filter((part): part is string => part !== undefined)
		.join(", ")
	if (!label) return undefined

	return {
		flag: flagEmoji(country),
		label,
		// Only when the name replaced the code — otherwise the tooltip would
		// repeat the row.
		title: regionName && regionCode ? qualifiedRegion(country, regionCode) : undefined,
	}
}

/** `US` + `TX` → `US-TX`; the bare code when the country is unknown. */
function qualifiedRegion(country: string | undefined, regionCode: string): string {
	return country ? `${country.toUpperCase()}-${regionCode}` : regionCode
}

/** A map lookup that missed returns `''`, which is not a part — drop it. */
function clean(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim()
	return trimmed ? trimmed : undefined
}
