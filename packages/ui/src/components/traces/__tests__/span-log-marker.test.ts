import { describe, expect, it } from "vitest"
import { spanLogMarkerLabel } from "../span-log-marker"

describe("spanLogMarkerLabel", () => {
	it("pluralizes the count", () => {
		expect(spanLogMarkerLabel({ count: 1, errorCount: 0 })).toBe("1 log")
		expect(spanLogMarkerLabel({ count: 12, errorCount: 0 })).toBe("12 logs")
	})

	// The badge's colour says "some of these are errors"; only the label says how
	// many, which is the difference between one error in forty and forty in forty.
	it("spells the error share when there is one", () => {
		expect(spanLogMarkerLabel({ count: 40, errorCount: 1 })).toBe("40 logs, 1 at error level")
		expect(spanLogMarkerLabel({ count: 1, errorCount: 1 })).toBe("1 log, 1 at error level")
	})

	it("says nothing about errors when there are none", () => {
		expect(spanLogMarkerLabel({ count: 3, errorCount: 0 })).not.toContain("error")
	})
})
