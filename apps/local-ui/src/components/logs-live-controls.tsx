// The Logs toolbar's live tail: reload now, reload every N, and why it is
// holding still. Ported from the hosted `logs-live-controls.tsx` and its
// `RefreshControls` split button, bound to local's own reload.

import type { ReactNode } from "react"
import { Button } from "@maple/ui/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { ArrowDownIcon, ChevronDownIcon } from "@maple/ui/components/icons"
import { cn } from "@maple/ui/lib/utils"
import {
	formatRefreshInterval,
	REFRESH_INTERVAL_OPTIONS,
	type LiveTailState,
	type RefreshIntervalSeconds,
} from "../lib/log-live-tail"

const OPTION_BY_VALUE = new Map<string, RefreshIntervalSeconds>(
	REFRESH_INTERVAL_OPTIONS.map((seconds) => [String(seconds), seconds]),
)

/**
 * Reload, then reload-every-N beside it, so "30s" next to the reload glyph can
 * only mean one thing. The held note sits left of the controls so its coming and going never moves
 * the cadence or the range select under the cursor.
 */
export function LogsLiveControls({
	value,
	onChange,
	state,
	onJumpToLatest,
	reloadButton,
}: {
	/** Reload now: rendered between the held note and the cadence, which it pairs with. */
	reloadButton: ReactNode
	value: RefreshIntervalSeconds
	onChange: (value: RefreshIntervalSeconds) => void
	state: LiveTailState
	onJumpToLatest: () => void
}) {
	const isOn = value > 0

	return (
		<div className="flex items-center gap-2">
			<output className="flex items-center gap-2" aria-live="polite">
				{state.held && (
					<span className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
						<span aria-hidden className="flex gap-0.5">
							<span className="h-2.5 w-0.5 rounded-full bg-current" />
							<span className="h-2.5 w-0.5 rounded-full bg-current" />
						</span>
						Paused while you inspect
					</span>
				)}
				{state.canJumpToLatest && (
					<Button type="button" variant="ghost" size="xs" onClick={onJumpToLatest}>
						<ArrowDownIcon className="rotate-180" />
						Jump to latest
					</Button>
				)}
			</output>
			<span className="flex items-center">
				{reloadButton}
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								type="button"
								variant="ghost"
								size="sm"
								title={
									isOn
										? `Reloading every ${formatRefreshInterval(value)}`
										: "Auto-refresh is off"
								}
								aria-label={
									isOn
										? `Auto-refresh every ${formatRefreshInterval(value)}`
										: "Auto-refresh off"
								}
								className="gap-1 px-1.5"
							/>
						}
					>
						<span className={cn("tabular-nums", !isOn && "text-muted-foreground")}>
							{formatRefreshInterval(value)}
						</span>
						<ChevronDownIcon className="size-3 opacity-60" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-40">
						<DropdownMenuGroup>
							<DropdownMenuLabel>Auto-refresh</DropdownMenuLabel>
							{/* Values are strings: the radio group compares by identity. */}
							<DropdownMenuRadioGroup
								value={String(value)}
								onValueChange={(next) => {
									const seconds = OPTION_BY_VALUE.get(String(next))
									if (seconds !== undefined) onChange(seconds)
								}}
							>
								{REFRESH_INTERVAL_OPTIONS.map((seconds) => (
									<DropdownMenuRadioItem key={seconds} value={String(seconds)}>
										{formatRefreshInterval(seconds)}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			</span>
		</div>
	)
}
