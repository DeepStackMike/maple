import { useEffect, useState } from "react"

/** Coarse enough that a list of sessions re-renders rarely, fine enough that a
 *  LIVE pill is never more than this far past the live window it claims. */
export const LIVE_CLOCK_INTERVAL_MS = 30_000

/**
 * A "now" that advances, for UI whose truth expires on a timer (the hosted
 * app's `use-live-clock.ts`).
 *
 * `Date.now()` read during render is a value, not a subscription: live-ness
 * computed from it stays frozen until some unrelated state change repaints the
 * row, so a LIVE pill would outlive its window on a page nobody touches. Pass
 * `enabled: false` when nothing on screen can expire and no timer is scheduled.
 */
export function useLiveClock({
	intervalMs = LIVE_CLOCK_INTERVAL_MS,
	enabled = true,
}: { intervalMs?: number; enabled?: boolean } = {}): number {
	const [nowMs, setNowMs] = useState(() => Date.now())

	useEffect(() => {
		if (!enabled) return
		// Re-sample on enable too: a clock disabled while the tab sat idle would
		// otherwise hand back the mount-time value.
		setNowMs(Date.now())
		const id = setInterval(() => setNowMs(Date.now()), intervalMs)
		return () => clearInterval(id)
	}, [intervalMs, enabled])

	return nowMs
}
