// Local bindings for the shared @maple/ui toolbar family: the refresh button
// invalidates the `["local", …]` React Query prefix, and the time-range select
// is bound to local mode's presets.

import { useCallback, useId, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Label } from "@maple/ui/components/ui/label"
import {
	RefreshButton as SharedRefreshButton,
	TimeRangeSelect as SharedTimeRangeSelect,
} from "@maple/ui/components/toolbar"
import { Popover, PopoverPopup } from "@maple/ui/components/ui/popover"
import { CUSTOM_RANGE_OPTION, formatAbsoluteRange, parseCustomRange, TIME_RANGES } from "../lib/time"
import { CustomRangePanel } from "./custom-range-popover"

export { Toolbar, ToolbarSearch, ToolbarStat, ToolbarStats } from "@maple/ui/components/toolbar"

/**
 * Manual reload for the active view. Every local hook keys off `["local", …]`,
 * so invalidating that prefix refetches exactly the mounted view's queries
 * (list + facets) — React Query only refetches active observers.
 */
export function RefreshButton({
	className,
	onBeforeRefresh,
}: {
	className?: string
	onBeforeRefresh?: () => void
}) {
	const queryClient = useQueryClient()
	const onRefresh = useCallback(() => {
		onBeforeRefresh?.()
		return queryClient.invalidateQueries({ queryKey: ["local"] })
	}, [onBeforeRefresh, queryClient])
	return <SharedRefreshButton onRefresh={onRefresh} className={className} />
}

const RANGE_LABELS: Record<string, string> = {
	"1h": "Last 1 hour",
	"6h": "Last 6 hours",
	"24h": "Last 24 hours",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
} satisfies Record<string, string>

/** What an unreadable range key resolves to — the same fallback `resolveRange` uses. */
const FALLBACK_RANGE_KEY = TIME_RANGES[TIME_RANGES.length - 1].key

const RANGE_OPTIONS = TIME_RANGES.map((range) => ({
	key: range.key,
	label: RANGE_LABELS[range.key] ?? range.label,
}))

/**
 * The range control: the presets, plus a window the user names themselves.
 *
 * The custom window is a *value of the same `range` param*, not a second piece
 * of page state — so it lands in the URL the presets already live in, survives
 * a reload, travels down every link the views emit, and reaches the query
 * builders through the one `boundsForRange` call each hook already makes.
 *
 * Picking "Custom range…" opens the popover without committing anything: the
 * select is controlled, so it snaps back to the live window until Apply, and
 * Cancel leaves the page exactly as it was.
 */
export function TimeRangeSelect({ value, onChange }: { value: string; onChange: (next: string) => void }) {
	const [open, setOpen] = useState(false)
	const anchorRef = useRef<HTMLDivElement>(null)
	const custom = parseCustomRange(value)
	// A hand-edited or stale URL can carry a key that is neither. `resolveRange`
	// answers it with the widest preset, so the control has to show that same
	// preset — a `<select>` whose value matches no option renders its *first*
	// one, which had the label saying "1 hour" over a 30-day query.
	const known = custom !== null || TIME_RANGES.some((r) => r.key === value)
	const selected = known ? value : FALLBACK_RANGE_KEY

	const ranges = [
		...RANGE_OPTIONS,
		// The active custom window needs an option of its own or the controlled
		// select has no matching value and silently shows the first preset.
		...(custom ? [{ key: value, label: formatAbsoluteRange(custom) }] : []),
		{ key: CUSTOM_RANGE_OPTION, label: "Custom range…" },
	]

	return (
		<div ref={anchorRef} className="flex items-center">
			<SharedTimeRangeSelect
				ranges={ranges}
				value={selected}
				onChange={(next) => {
					if (next === CUSTOM_RANGE_OPTION) setOpen(true)
					else {
						// Picking a preset while the picker is up answers the same
						// question the picker asks — take the preset and put it away.
						setOpen(false)
						onChange(next)
					}
				}}
			/>
			<Popover
				open={open}
				onOpenChange={(next, details) => {
					// `cancel()` and not just "don't call setOpen": Base UI keeps its own
					// copy of the open state and closes it whether or not the controlled
					// prop follows, unless the change is cancelled here.
					if (!next && dismissedByOwnControl(anchorRef.current, details)) {
						details.cancel()
						return
					}
					setOpen(next)
				}}
			>
				{/* Aligned to the control's right edge — it sits at the end of the
				    toolbar, and opening rightwards would run off the viewport. */}
				<PopoverPopup anchor={anchorRef} align="end" className="w-[24rem]">
					{open && (
						<CustomRangePanel
							currentRange={selected}
							onApply={(next) => {
								setOpen(false)
								onChange(next)
							}}
							onCancel={() => setOpen(false)}
						/>
					)}
				</PopoverPopup>
			</Popover>
		</div>
	)
}

/**
 * Whether a Base UI close request is really just the tail of the interaction
 * that opened the popover.
 *
 * A native `<select>` picked with the mouse fires `change` *before* the `click`
 * that ends the press — Chrome delivers the click to the `<select>` once its
 * platform menu has closed. The popover opens on the `change`, so that click
 * arrives with the popover already up, lands outside the popup, and Base UI
 * reads it as an outside press and closes the popup in the same frame it
 * appeared: the option worked, and nothing was ever visible. (A synthetic
 * `selectOption`/`fireEvent.change` sends no click, which is why this only
 * showed up under a real pointer.)
 *
 * So dismissals whose event belongs to the control itself — the select, its
 * wrapper, the chevron — are not presses outside the popover, and are ignored.
 * Everything else still dismisses: Escape, a press anywhere else on the page,
 * Cancel, Apply.
 */
function dismissedByOwnControl(anchor: HTMLElement | null, details: { event?: Event | undefined }): boolean {
	const event = details.event
	if (!anchor || !event) return false
	const within = (node: EventTarget | null) => node instanceof Node && anchor.contains(node)
	// `relatedTarget` covers focus leaving the popup *for* the select, which is
	// where focus returns when the platform menu closes.
	return within(event.target) || (event instanceof FocusEvent && within(event.relatedTarget))
}

/**
 * The probe filter, as a toolbar checkbox rather than a sidebar facet.
 *
 * It is not a facet: every facet section lists values the data reported and
 * counts them, and this one lists nothing — it is a standing decision about
 * what the view is for, which is why it sits beside the time range and survives
 * a reload. Spelled as what it *does* ("Hide health checks") and not as its
 * state, so the label does not change under the click that changes the box.
 */
export function HideHealthChecksToggle({
	hidden,
	onChange,
}: {
	hidden: boolean
	onChange: (hidden: boolean) => void
}) {
	const id = useId()
	return (
		<span className="flex items-center gap-1.5" title={HIDE_HEALTH_CHECKS_HINT}>
			<Checkbox id={id} checked={hidden} onCheckedChange={(val) => onChange(val === true)} />
			<Label htmlFor={id} className="cursor-pointer whitespace-nowrap text-xs font-normal">
				Hide health checks
			</Label>
		</span>
	)
}

const HIDE_HEALTH_CHECKS_HINT =
	"Hides traces whose route looks like a liveness probe — /health, /ready, /live, /ping, /api/telemetry"
