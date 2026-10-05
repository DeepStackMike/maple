// The "Custom range" half of the toolbar's time-range control.
//
// Two `datetime-local` inputs rather than a calendar widget: the question a
// user brings here is "what happened between the deploy at 14:10 and the
// rollback at 14:40", which is a typed answer, and the native control already
// carries the platform's own date picker, locale and keyboard behaviour. The
// inputs read and write the *local* clock — the same clock the label prints —
// while the range key the popover applies is UTC epoch seconds.

import { useCallback, useMemo, useState } from "react"
import { Button } from "@maple/ui/components/ui/button"
import { Label } from "@maple/ui/components/ui/label"
import {
	customRangeError,
	customRangeKey,
	fromDateTimeLocalInput,
	parseCustomRange,
	toDateTimeLocalInput,
	resolveRangeWindow,
} from "../lib/time"

/**
 * Seed the inputs with the window already on screen, whichever kind it is, so
 * "Custom" from a `24H` view opens on that same 24 hours and the first edit is
 * a nudge rather than a fresh pair of timestamps.
 */
function seedInputs(currentRange: string | undefined): { from: string; to: string } {
	const custom = parseCustomRange(currentRange)
	if (custom) {
		return { from: toDateTimeLocalInput(custom.fromMs), to: toDateTimeLocalInput(custom.toMs) }
	}
	const resolved = resolveRangeWindow(currentRange)
	return { from: toDateTimeLocalInput(resolved.startMs), to: toDateTimeLocalInput(resolved.endMs) }
}

export function CustomRangePanel({
	currentRange,
	onApply,
	onCancel,
}: {
	currentRange: string | undefined
	onApply: (rangeKey: string) => void
	onCancel: () => void
}) {
	const [{ from, to }, setInputs] = useState(() => seedInputs(currentRange))

	const parsed = useMemo(
		() => ({ fromMs: fromDateTimeLocalInput(from), toMs: fromDateTimeLocalInput(to) }),
		[from, to],
	)
	// Recomputed on every keystroke rather than on submit: the Apply button is
	// the only way out, and a disabled button with no reason beside it is a dead
	// end. `?? undefined` so a half-typed field reads as "not filled in yet".
	const error = customRangeError({
		fromMs: parsed.fromMs ?? undefined,
		toMs: parsed.toMs ?? undefined,
	})

	const apply = useCallback(() => {
		if (parsed.fromMs === null || parsed.toMs === null || error) return
		onApply(customRangeKey({ fromMs: parsed.fromMs, toMs: parsed.toMs }))
	}, [error, onApply, parsed.fromMs, parsed.toMs])

	return (
		<form
			className="space-y-3"
			onSubmit={(e) => {
				e.preventDefault()
				apply()
			}}
		>
			<div className="grid grid-cols-2 gap-2">
				<Field
					label="From"
					value={from}
					onChange={(value) => setInputs((prev) => ({ ...prev, from: value }))}
				/>
				<Field
					label="To"
					value={to}
					onChange={(value) => setInputs((prev) => ({ ...prev, to: value }))}
				/>
			</div>

			<p className="min-h-4 text-xs text-destructive empty:min-h-0" role={error ? "alert" : undefined}>
				{error}
			</p>

			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="submit" size="sm" disabled={error !== null}>
					Apply
				</Button>
			</div>
		</form>
	)
}

function Field({
	label,
	value,
	onChange,
}: {
	label: string
	value: string
	onChange: (value: string) => void
}) {
	return (
		<Label className="flex flex-col items-start gap-1 text-xs font-normal">
			<span className="text-muted-foreground">{label}</span>
			<input
				type="datetime-local"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
			/>
		</Label>
	)
}
