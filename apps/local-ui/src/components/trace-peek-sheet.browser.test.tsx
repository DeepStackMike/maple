// The peek sheet's keyboard contract: focus lands on the sheet, the arrows walk
// the list, Enter promotes the peek to the page, and the ends of the list (or a
// peek with no loaded row) disable the arrows instead of misbehaving.

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { TracePeekSheet, type TracePeekSheetProps } from "./trace-peek-sheet"

afterEach(cleanup)

// The body is the caller's (the list composes `TracePeekBody` in), so the
// keyboard contract is tested against a stand-in with no data dependencies.
function renderSheet(overrides: Partial<Omit<TracePeekSheetProps, "children">> = {}) {
	const props: Omit<TracePeekSheetProps, "children"> = {
		traceId: "abc123def456",
		position: { index: 1, count: 3 },
		onStep: vi.fn(),
		onClose: vi.fn(),
		openHref: "#/traces/abc123def456",
		...overrides,
	}
	render(
		<TracePeekSheet {...props}>
			<p>Trace body</p>
		</TracePeekSheet>,
	)
	return props
}

describe("TracePeekSheet", () => {
	it("puts focus on the sheet and steps with the arrows and j/k", async () => {
		const props = renderSheet()
		const dialog = await screen.findByRole("dialog")
		await waitFor(() => expect(document.activeElement).toBe(dialog))
		fireEvent.keyDown(dialog, { key: "ArrowDown" })
		fireEvent.keyDown(dialog, { key: "k" })
		expect(props.onStep).toHaveBeenNthCalledWith(1, 1)
		expect(props.onStep).toHaveBeenNthCalledWith(2, -1)
		expect(screen.getByText("2 of 3")).toBeDefined()
	})

	it("promotes the peek to the page on Enter", async () => {
		renderSheet()
		const dialog = await screen.findByRole("dialog")
		const link = screen.getByRole("link", { name: /Open trace/ })
		expect(link.getAttribute("href")).toBe("#/traces/abc123def456")
		const clicked = vi.fn((event: Event) => event.preventDefault())
		link.addEventListener("click", clicked)
		fireEvent.keyDown(dialog, { key: "Enter" })
		expect(clicked).toHaveBeenCalledOnce()
	})

	it("disables the arrows at the ends and without a loaded row", async () => {
		renderSheet({ position: { index: 0, count: 1 } })
		await screen.findByRole("dialog")
		expect(screen.getByRole("button", { name: "Previous trace" }).hasAttribute("disabled")).toBe(true)
		expect(screen.getByRole("button", { name: "Next trace" }).hasAttribute("disabled")).toBe(true)
		cleanup()
		renderSheet({ position: null })
		await screen.findByRole("dialog")
		expect(screen.queryByText(/ of /)).toBeNull()
		expect(screen.getByRole("button", { name: "Next trace" }).hasAttribute("disabled")).toBe(true)
	})

	it("closes on Escape", async () => {
		const props = renderSheet()
		const dialog = await screen.findByRole("dialog")
		fireEvent.keyDown(dialog, { key: "Escape" })
		await waitFor(() => expect(props.onClose).toHaveBeenCalled())
	})
})
