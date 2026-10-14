import { formatLocalTimestamp } from "../lib/time"

/** `HH:MM:SS` at full strength, the milliseconds a step back: the eye reads seconds first. */
export function LogTime({ timestamp }: { timestamp: string }) {
	const formatted = formatLocalTimestamp(timestamp)
	const dot = formatted.lastIndexOf(".")
	if (dot === -1) return formatted
	return (
		<>
			{formatted.slice(0, dot)}
			<span className="text-muted-foreground/50">{formatted.slice(dot)}</span>
		</>
	)
}
