// @vitest-environment jsdom
//
// The regression this file exists for: local-ui shipped `highlightJson` and a
// `sugar-high` dependency, and *nothing on screen was coloured*, because the
// app's `styles.css` never defined the `--sh-*` custom properties Sugar High
// writes into each token's inline `color`. A component test cannot see a
// resolved colour — jsdom has no cascade to ask — but it can prove that the
// tokens reach the DOM carrying the hook a colour attaches to, which is the
// half of the failure that lives in this repo. The other half is the palette in
// `styles.css`, and the build output is where that gets checked.

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { CodeBlock } from "./code-block"

afterEach(cleanup)

describe("CodeBlock", () => {
	it("hands JSON to Sugar High, pretty-printed, with coloured tokens", () => {
		const { container } = render(<CodeBlock value='{"role":"user","n":1}' />)

		const tokens = container.querySelectorAll("[class*='sh__token--']")
		expect(tokens.length).toBeGreaterThan(0)
		// Every token carries the inline `color: var(--sh-*)` that the palette
		// answers. Without the palette this is exactly what rendered as body text.
		for (const token of tokens) {
			expect(token.getAttribute("style")).toContain("var(--sh-")
		}
		expect(container.querySelector("pre")?.textContent).toContain('"role": "user"')
	})

	it("colours SQL with the shared palette classes and names its placeholders", () => {
		const { container } = render(<CodeBlock value="SELECT id FROM users WHERE id = $1" />)

		expect(screen.getByTitle("sql")).toBeTruthy()
		expect(container.querySelector(".text-code-keyword")?.textContent).toBe("SELECT")
		expect(container.querySelector(".text-code-placeholder")?.textContent).toBe("$1")
	})

	it("toggles between the pretty and raw renditions", () => {
		const { container } = render(<CodeBlock value='{"a":1}' />)
		const pre = () => container.querySelector("pre")?.textContent ?? ""

		expect(pre()).toBe('{\n  "a": 1\n}')
		fireEvent.click(screen.getByRole("button", { name: "Show the raw value" }))
		expect(pre()).toBe('{"a":1}')
		fireEvent.click(screen.getByRole("button", { name: "Pretty-print" }))
		expect(pre()).toBe('{\n  "a": 1\n}')
	})

	it("offers no toggle for a value with only one rendition", () => {
		render(<CodeBlock value="SELECT 1 FROM t" />)
		expect(screen.queryByRole("button", { name: "Show the raw value" })).toBeNull()
	})

	it("clamps the text itself past the fold, and restores it on Show all", () => {
		const lines = Array.from({ length: 9 }, (_, index) => `line ${index}`).join("\n")
		const { container } = render(<CodeBlock value={lines} collapseAfter={3} />)

		// Cut, not merely hidden: highlighting 9 lines to paint 3 is work thrown
		// away, and a CSS clamp would leave the rest in the DOM.
		expect(container.querySelector("pre")?.textContent).toBe("line 0\nline 1\nline 2")
		fireEvent.click(screen.getByRole("button", { name: "Show all lines" }))
		expect(container.querySelector("pre")?.textContent).toBe(lines)
	})

	it("numbers both renderers off the same line class", () => {
		// Three lines each: JSON once pretty-printed, SQL as sent.
		for (const value of ['{"a": 1}', "SELECT 1\nFROM t\nWHERE id = 1"]) {
			const { container } = render(<CodeBlock value={value} lineNumbers />)
			expect(container.querySelector(".code-block--numbered")).toBeTruthy()
			expect(container.querySelectorAll(".sh__line").length).toBe(3)
			cleanup()
		}
	})

	it("draws nothing for an empty value", () => {
		const { container } = render(<CodeBlock value="" />)
		expect(container.firstChild).toBeNull()
	})
})
