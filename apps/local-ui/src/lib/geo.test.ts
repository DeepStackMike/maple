import { describe, expect, it } from "vitest"
import { countryLabel, countryName, flagEmoji, formatLocation } from "./geo"

describe("country codes", () => {
	it("names a country from its ISO code, case-insensitively", () => {
		expect(countryName("DE")).toBe("Germany")
		expect(countryName("de")).toBe("Germany")
		expect(countryName("PR")).toBe("Puerto Rico")
	})

	// The column is a gateway-resolved header, but a hand-written filter or an
	// older row can carry anything. Unknown is unknown, not mojibake.
	it("has no name for anything that is not a country code", () => {
		expect(countryName("")).toBeUndefined()
		expect(countryName(null)).toBeUndefined()
		expect(countryName("unknown")).toBeUndefined()
		expect(countryName("QQ")).toBeUndefined()
	})

	it("builds the flag from regional indicators", () => {
		expect(flagEmoji("DE")).toBe("🇩🇪")
		expect(flagEmoji("us")).toBe("🇺🇸")
	})

	// A region code through `flagEmoji` would render as two letter blocks that
	// look like a flag for a country that does not exist.
	it("has no flag for a non-country value", () => {
		expect(flagEmoji("")).toBeUndefined()
		expect(flagEmoji("TX")).toBe("🇹🇽") // two letters IS a code — the caller passes countries
		expect(flagEmoji("127")).toBeUndefined()
		expect(flagEmoji(undefined)).toBeUndefined()
	})

	it("labels a code with its flag and name, and passes anything else through", () => {
		expect(countryLabel("DE")).toBe("🇩🇪 Germany")
		expect(countryLabel("")).toBe("")
		expect(countryLabel("unknown")).toBe("unknown")
		// A structurally valid code CLDR does not know keeps its flag and its code.
		expect(countryLabel("QQ")).toBe("🇶🇶 QQ")
	})
})

describe("location line", () => {
	it("reads coarsest-last, with the country spelled out", () => {
		expect(
			formatLocation({ country: "US", regionCode: "TX", regionName: "Texas", city: "Austin" }),
		).toEqual({ flag: "🇺🇸", label: "Austin, Texas, United States", title: "US-TX" })
	})

	// The whole reason the sidecar writes `geo.region.name`: `PR-127` is a real
	// subdivision and unreadable, so the name leads and the code is the tooltip.
	it("prefers the region name and keeps the code as the tooltip", () => {
		const location = formatLocation({
			country: "PR",
			regionCode: "127",
			regionName: "San Juan",
			city: "San Juan",
		})
		expect(location?.label).toBe("San Juan, San Juan, Puerto Rico")
		expect(location?.title).toBe("PR-127")
	})

	// Nothing to stand in for, so nothing to disclose on hover.
	it("falls back to the code when the sidecar resolved no region name", () => {
		expect(formatLocation({ country: "DE", regionCode: "NRW" })).toEqual({
			flag: "🇩🇪",
			label: "NRW, Germany",
			title: undefined,
		})
	})

	it("skips the parts the sidecar could not resolve", () => {
		expect(formatLocation({ country: "FR" })?.label).toBe("France")
		expect(formatLocation({ city: "Austin" })?.label).toBe("Austin")
		expect(formatLocation({ country: "", regionCode: "", city: "  " })).toBeUndefined()
		expect(formatLocation({})).toBeUndefined()
	})

	// A country the region cannot be qualified by leaves the bare subdivision
	// code, which is still what the raw attribute says.
	it("qualifies the region code by its country only when there is one", () => {
		expect(formatLocation({ regionCode: "TX", regionName: "Texas" })?.title).toBe("TX")
	})

	it("keeps an unnamed country code rather than dropping the session's only geography", () => {
		expect(formatLocation({ country: "QQ" })).toEqual({
			flag: "🇶🇶",
			label: "QQ",
			title: undefined,
		})
	})
})
