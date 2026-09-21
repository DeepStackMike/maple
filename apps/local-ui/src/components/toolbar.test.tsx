// @vitest-environment jsdom
//
// The custom-range path through the toolbar's range control: the picker has to
// open without committing anything, and Apply has to hand back the one opaque
// `range` value every view already knows how to thread.

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { TimeRangeSelect } from "./toolbar"
import { customRangeKey } from "../lib/time"

afterEach(cleanup)

function openPicker(value = "24h") {
	const onChange = vi.fn()
	render(<TimeRangeSelect value={value} onChange={onChange} />)
	fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } })
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

	it("shows the preset a bad URL actually resolves to, not the first option", () => {
		render(<TimeRangeSelect value="custom_bogus" onChange={vi.fn()} />)
		expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("30d")
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
