// The "this span wrote logs" marker, shared by the waterfall and the timeline.
//
// A span's logs are already one click away in the detail panel, and that is
// exactly the problem: finding *which* span logged anything meant opening every
// row in turn. The marker moves that one fact — there are N of them, some are
// errors — onto the row itself, so the reader picks the span to open instead of
// searching for it.

import { CodeIcon } from "../icons"
import { cn } from "../../lib/utils"
import type { SpanLogMarker } from "./trace-view-context"

/**
 * The marker's hover text.
 *
 * Spells the error count rather than relying on the colour: a red badge says
 * "something here is an error", not how much of it is, and the difference
 * between one error among forty logs and forty out of forty decides whether the
 * span is worth opening.
 */
export function spanLogMarkerLabel(marker: SpanLogMarker): string {
	const logs = `${marker.count} ${marker.count === 1 ? "log" : "logs"}`
	if (marker.errorCount <= 0) return logs
	return `${logs}, ${marker.errorCount} at error level`
}

interface SpanLogMarkerBadgeProps {
	marker: SpanLogMarker | undefined
	/** Omit to render the marker as plain, non-interactive chrome. */
	onOpen?: () => void
	className?: string
}

/**
 * Renders nothing for a span with no logs — including one whose row the counts
 * query simply never returned, which is the same claim.
 */
export function SpanLogMarkerBadge({ marker, onOpen, className }: SpanLogMarkerBadgeProps) {
	if (!marker || marker.count <= 0) return null

	const label = spanLogMarkerLabel(marker)
	const erroring = marker.errorCount > 0
	const badgeClass = cn(
		"flex shrink-0 items-center gap-0.5 rounded px-1 font-mono text-[10px] leading-none tabular-nums",
		erroring ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
		className,
	)
	const body = (
		<>
			<CodeIcon size={9} className="shrink-0" />
			{marker.count}
		</>
	)

	if (!onOpen) {
		return (
			<span className={cn(badgeClass, "py-0.5")} title={label} aria-label={label}>
				{body}
			</span>
		)
	}

	return (
		<button
			type="button"
			// The row around it is itself a click target that selects the span, and
			// this click means something narrower: open it *on its logs*. Stopping
			// propagation is what keeps the two from both firing and the second from
			// undoing the first.
			onClick={(event) => {
				event.stopPropagation()
				onOpen()
			}}
			onKeyDown={(event) => event.stopPropagation()}
			className={cn(
				badgeClass,
				"cursor-pointer py-0.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				erroring ? "hover:bg-destructive/20" : "hover:bg-muted-foreground/20",
			)}
			title={`${label} — open this span's logs`}
			aria-label={`${label}. Open this span's logs`}
		>
			{body}
		</button>
	)
}
