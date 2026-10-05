// The custom-range path through the toolbar's range control: the picker has to
// open without committing anything, and Apply has to hand back the one opaque
// `range` value every view already knows how to thread.

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { TimeRangeSelect } from "./toolbar"
import { customRangeKey, DEFAULT_RANGE } from "../lib/time"

afterEach(cleanup)

/**
 * Pick "Custom range…" the way a mouse does: a `change`, and then the `click`
 * the browser delivers to the `<select>` once its platform menu has closed.
 * The trailing click is the whole point — it lands outside the popup, and
 * without it this test cannot see the bug it exists for.
 */
function pickCustom() {
	const select = screen.getByRole("combobox")
	fireEvent.change(select, { target: { value: "custom" } })
	fireEvent.click(select)
}

function openPicker(value = "24h") {
	const onChange = vi.fn()
	render(<TimeRangeSelect value={value} onChange={onChange} />)
	pickCustom()
	return onChange
}

describe("TimeRangeSelect", () => {
	it("offers the presets alongside a custom window", () => {
		render(<TimeRangeSelect value="24h" onChange={vi.fn()} />)
		expect(screen.getByRole("option", { name: "Last 24 hours" })).toBeDefined()
		expect(screen.getByRole("option", { name: "Custom range…" })).toBeDefined()
	})

	it("opens the picker without changing the window", () => {
		const onChange = openPicker()
		expect(screen.getByLabelText("From")).toBeDefined()
		expect(onChange).not.toHaveBeenCalled()
	})

	it("applies the typed window as a single range value", () => {
		const onChange = openPicker()
		fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-18T09:00" } })
		fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-19T17:30" } })
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))

		expect(onChange).toHaveBeenCalledWith(
			customRangeKey({
				fromMs: new Date(2026, 8, 18, 9, 0).getTime(),
				toMs: new Date(2026, 8, 19, 17, 30).getTime(),
			}),
		)
	})

	it("refuses a backwards window and says why", () => {
		openPicker()
		fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-19T17:30" } })
		fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-18T09:00" } })

		expect(screen.getByRole("alert").textContent).toMatch(/after the start/i)
		expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true)
	})

	it("shows the preset a bad URL actually resolves to", () => {
		render(<TimeRangeSelect value="custom_bogus" onChange={vi.fn()} />)
		expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(DEFAULT_RANGE)
	})

	it("survives the click the select fires after the change", () => {
		openPicker()
		// The popover opens during `change`; Base UI sees the `click` that follows
		// as a press outside it. It is the tail of the press that opened it.
		expect(screen.getByLabelText("From")).toBeDefined()
	})

	it("reopens after the picker was dismissed", () => {
		openPicker()
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		expect(screen.queryByLabelText("From")).toBeNull()

		pickCustom()
		expect(screen.getByLabelText("From")).toBeDefined()
	})

	it("reopens on a window that is already custom", () => {
		const key = customRangeKey({
			fromMs: new Date(2026, 8, 18, 9, 0).getTime(),
			toMs: new Date(2026, 8, 19, 17, 30).getTime(),
		})
		render(<TimeRangeSelect value={key} onChange={vi.fn()} />)
		pickCustom()
		expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-09-18T09:00")
	})

	it("takes a preset picked while the picker is open, and puts the picker away", () => {
		const onChange = openPicker()
		const select = screen.getByRole("combobox")
		fireEvent.change(select, { target: { value: "6h" } })
		fireEvent.click(select)

		expect(onChange).toHaveBeenCalledWith("6h")
		expect(screen.queryByLabelText("From")).toBeNull()
	})

	it("still closes on a press somewhere else on the page", () => {
		openPicker()
		fireEvent.pointerDown(document.body)
		fireEvent.click(document.body)
		expect(screen.queryByLabelText("From")).toBeNull()
	})

	it("shows an active custom window as the selected option", () => {
		const key = customRangeKey({
			fromMs: new Date(2026, 8, 18, 9, 0).getTime(),
			toMs: new Date(2026, 8, 19, 17, 30).getTime(),
		})
		render(<TimeRangeSelect value={key} onChange={vi.fn()} />)
		const select = screen.getByRole("combobox") as HTMLSelectElement
		expect(select.value).toBe(key)
		expect(screen.getByRole("option", { name: /Sep 18.*→.*Sep 19/ })).toBeDefined()
	})
})
