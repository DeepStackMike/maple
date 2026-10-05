// The Logs page's volume strip: one stacked column per bucket, split by severity.
//
// The hosted chart is `@tanstack/charts` — `barY` with a `stack()` layout, a
// canvas renderer and a focus store. None of that is carried in here, for the
// same reason the service map's drawing is not React Flow: this is one `<svg>`
// at natural scale (1 unit = 1 CSS pixel), which is what lets the tooltip be a
// plain absolutely-positioned div at a column's x, and what keeps the page's
// dependency list where it is.
//
// The other reason is colour. Every query-builder chart in `@maple/ui` assigns
// series colours by hashing the series *name* into the identity palette, and a
// severity histogram whose ERROR band is whatever hue "ERROR" hashes to cannot
// agree with the coloured squares in the filter sidebar beside it. `colorOf`
// here is the same `getSeverityColor` those squares use, so a band and its
// facet row are the same colour by construction rather than by coincidence.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { formatBucketLabel, formatNumber } from "@maple/ui/lib/format"
import { getSeverityColor } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import { toClickHouseDateTime } from "../lib/time"
import {
	niceCeiling,
	pickTickIndices,
	type LogHistogram,
	type LogHistogramBucket,
} from "../lib/log-histogram"

/** Tall enough to read a shape off, short enough that the list stays the page. */
const PLOT_HEIGHT = 92
const AXIS_HEIGHT = 18
/** Headroom above the tallest column so a full bar does not touch the top rule. */
const TOP_PAD = 4
/** Room for the count axis's widest label ("1.5M"). */
const Y_GUTTER = 44
const RIGHT_PAD = 8

/** Roughly this many time labels along the bottom, thinned to whole columns. */
const X_TICK_TARGET = 6

export interface LogSeverityHistogramProps {
	histogram: LogHistogram
	/** Narrows the page's window to one bucket. Omit to draw a non-interactive strip. */
	onZoomToBucket?: (bucket: LogHistogramBucket) => void
	/** True while a refetch is in flight behind the columns currently drawn. */
	stale?: boolean
}

export function LogSeverityHistogram({ histogram, onZoomToBucket, stale }: LogSeverityHistogramProps) {
	const containerRef = useRef<HTMLDivElement>(null)
	const [width, setWidth] = useState(0)
	const [active, setActive] = useState<number | null>(null)

	// Measured rather than solved from a viewBox: a `preserveAspectRatio="none"`
	// viewBox would stretch every tick label horizontally with the container.
	useEffect(() => {
		const element = containerRef.current
		if (!element) return
		setWidth(element.clientWidth)
		const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
		observer.observe(element)
		return () => observer.disconnect()
	}, [])

	const { buckets, levels, bucketSeconds, maxTotal } = histogram
	const count = buckets.length

	const axisContext = useMemo(() => {
		if (count === 0) return { rangeMs: 0, bucketSeconds }
		return { rangeMs: buckets[count - 1].endMs - buckets[0].startMs, bucketSeconds }
	}, [buckets, count, bucketSeconds])

	const colorOf = useMemo(() => {
		const colors: Record<string, string> = {}
		for (const level of levels) colors[level] = getSeverityColor(level)
		return colors
	}, [levels])

	const yMax = niceCeiling(maxTotal)
	const plotWidth = Math.max(0, width - Y_GUTTER - RIGHT_PAD)
	const slot = count > 0 ? plotWidth / count : 0
	// Sub-pixel columns still have to paint: a bar rounded to zero width is a
	// bucket that silently is not on the chart.
	const barWidth = Math.max(1, slot - (slot > 3 ? 1 : 0))
	const usableHeight = PLOT_HEIGHT - TOP_PAD
	const scale = (value: number) => (value / yMax) * usableHeight

	const zoom = useCallback(
		(index: number) => {
			const bucket = buckets[index]
			if (bucket && onZoomToBucket) onZoomToBucket(bucket)
		},
		[buckets, onZoomToBucket],
	)

	// Arrow keys rather than a tab stop per column: 200 focusable rects is a
	// keyboard trap, and one focusable chart that walks its own buckets puts
	// every number the tooltip carries within reach without one.
	const onKeyDown = (event: KeyboardEvent) => {
		if (count === 0) return
		if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
			event.preventDefault()
			const step = event.key === "ArrowRight" ? 1 : -1
			setActive((current) => {
				const next = current === null ? (step > 0 ? 0 : count - 1) : current + step
				return Math.min(count - 1, Math.max(0, next))
			})
		} else if (event.key === "Home") {
			event.preventDefault()
			setActive(0)
		} else if (event.key === "End") {
			event.preventDefault()
			setActive(count - 1)
		} else if (event.key === "Enter" || event.key === " ") {
			if (active === null || !onZoomToBucket) return
			event.preventDefault()
			zoom(active)
		} else if (event.key === "Escape") {
			setActive(null)
		}
	}

	const xTicks = useMemo(() => pickTickIndices(count, X_TICK_TARGET), [count])
	const activeBucket = active !== null ? buckets[active] : undefined

	return (
		<div
			ref={containerRef}
			tabIndex={count > 0 ? 0 : -1}
			role="group"
			aria-label={`Log volume by severity — ${count} buckets, peak ${maxTotal.toLocaleString()} logs`}
			onKeyDown={onKeyDown}
			onBlur={() => setActive(null)}
			onPointerLeave={() => setActive(null)}
			className={cn(
				"relative w-full rounded-sm outline-none transition-opacity focus-visible:ring-1 focus-visible:ring-ring",
				stale && "opacity-60",
			)}
			style={{ height: PLOT_HEIGHT + AXIS_HEIGHT }}
		>
			{width > 0 && count > 0 ? (
				<svg
					width={width}
					height={PLOT_HEIGHT + AXIS_HEIGHT}
					className="block"
					aria-hidden="true"
					focusable="false"
				>
					{/* Count axis: zero, half, full. Three lines is the most a strip
					    this short can carry without the labels colliding. */}
					{[0, 0.5, 1].map((fraction) => {
						const y = PLOT_HEIGHT - scale(yMax * fraction)
						return (
							<g key={fraction}>
								<line
									x1={Y_GUTTER}
									x2={width - RIGHT_PAD}
									y1={y}
									y2={y}
									className="stroke-border"
									strokeWidth={1}
									strokeDasharray={fraction === 0 ? undefined : "2 3"}
								/>
								<text
									x={Y_GUTTER - 6}
									y={y + 3}
									textAnchor="end"
									className="fill-muted-foreground text-[9px] tabular-nums"
								>
									{formatNumber(yMax * fraction)}
								</text>
							</g>
						)
					})}

					{buckets.map((bucket, index) => {
						let top = PLOT_HEIGHT
						return (
							<g key={bucket.startMs}>
								{levels.map((level) => {
									const value = bucket.counts[level] ?? 0
									if (value <= 0) return null
									const height = scale(value)
									top -= height
									return (
										<rect
											key={level}
											x={Y_GUTTER + index * slot}
											y={top}
											width={barWidth}
											height={height}
											fill={colorOf[level]}
											opacity={active === null || active === index ? 1 : 0.45}
										/>
									)
								})}
							</g>
						)
					})}

					{/* One transparent full-height hit area per column, drawn last so a
					    one-pixel-tall band is still as easy to hover as a full one. */}
					{buckets.map((bucket, index) => (
						<rect
							key={bucket.startMs}
							x={Y_GUTTER + index * slot}
							y={0}
							width={Math.max(1, slot)}
							height={PLOT_HEIGHT}
							fill="transparent"
							className={onZoomToBucket ? "cursor-zoom-in" : undefined}
							onPointerEnter={() => setActive(index)}
							onClick={() => zoom(index)}
						/>
					))}

					{xTicks.map((index) => (
						<text
							key={index}
							x={Y_GUTTER + (index + 0.5) * slot}
							y={PLOT_HEIGHT + 12}
							textAnchor={index === 0 ? "start" : index === count - 1 ? "end" : "middle"}
							className="fill-muted-foreground text-[9px] tabular-nums"
						>
							{formatBucketLabel(
								toClickHouseDateTime(buckets[index].startMs),
								axisContext,
								"tick",
							)}
						</text>
					))}
				</svg>
			) : null}

			{activeBucket ? (
				<BucketTooltip
					bucket={activeBucket}
					levels={levels}
					colorOf={colorOf}
					axisContext={axisContext}
					// Beside the column, never over it. A card centred on its own
					// subject hides the one bar the reader is asking about — and in a
					// 110px strip it hides the tall ones first, which are the bars
					// anyone hovers. It flips to whichever half has the room.
					anchor={anchorTooltip(Y_GUTTER + ((active ?? 0) + 0.5) * slot, width)}
				/>
			) : null}
		</div>
	)
}

function BucketTooltip({
	bucket,
	levels,
	colorOf,
	axisContext,
	anchor,
}: {
	bucket: LogHistogramBucket
	levels: ReadonlyArray<string>
	colorOf: Record<string, string>
	axisContext: { rangeMs: number; bucketSeconds: number | undefined }
	anchor: { left: number } | { right: number }
}) {
	// Only the levels this bucket actually has: a fixed row per series turns a
	// quiet bucket into a column of zeroes the reader has to scan past.
	const rows = levels.filter((level) => (bucket.counts[level] ?? 0) > 0)

	return (
		<div
			className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-md border bg-popover px-2.5 py-2 text-xs shadow-md"
			style={anchor}
			role="status"
		>
			<div className="mb-1.5 font-medium">
				{formatBucketLabel(toClickHouseDateTime(bucket.startMs), axisContext, "tooltip")}
			</div>
			{rows.map((level) => (
				<div key={level} className="flex items-center gap-2">
					<span
						className="size-2 shrink-0 rounded-[35%] [corner-shape:squircle]"
						style={{ backgroundColor: colorOf[level] }}
					/>
					<span className="flex-1 text-muted-foreground">{level}</span>
					<span className="tabular-nums">{bucket.counts[level]?.toLocaleString()}</span>
				</div>
			))}
			<div className="mt-1.5 flex items-center gap-2 border-t pt-1.5">
				<span className="flex-1 text-muted-foreground">Total</span>
				<span className="tabular-nums">{bucket.total.toLocaleString()}</span>
			</div>
		</div>
	)
}

/**
 * Which side of the hovered column the tooltip hangs off, as a CSS offset from
 * the container's matching edge. Whichever half of the plot the column sits in,
 * the card goes to the other one.
 */
function anchorTooltip(columnX: number, width: number): { left: number } | { right: number } {
	const GAP = 10
	return columnX < width / 2 ? { left: columnX + GAP } : { right: width - columnX + GAP }
}

/** Number of time labels along the empty strip's baseline. */
const EMPTY_STRIP_TICKS = 5

/** Ghost columns behind the empty strip's caption: a silhouette of the histogram, not data. */
const EMPTY_STRIP_BARS = 64

/**
 * The severities the empty strip's legend names, in the stacking order the real
 * histogram uses (`orderBySeverity`), so the caption describes the chart that
 * will replace it.
 */
const EMPTY_STRIP_LEGEND = ["INFO", "WARN", "ERROR", "DEBUG", "TRACE"] as const

/**
 * Deterministic ghost columns (heights as a fraction of the plot) so the
 * silhouette is the same on every render — a random one would flicker like it
 * was loading. Two slow sine waves give a soft, plausibly log-like contour, and
 * each column is split into severity slices bottom-up the way the real strip
 * stacks them: mostly info, a thin warn band, an occasional error cap. Ported
 * from the hosted volume chart's empty state.
 */
const EMPTY_STRIP_COLUMNS = Array.from({ length: EMPTY_STRIP_BARS }, (_, i) => {
	const t = i / (EMPTY_STRIP_BARS - 1)
	const wave = 0.5 + 0.3 * Math.sin(t * Math.PI * 3.1 + 0.8) + 0.2 * Math.sin(t * Math.PI * 7.3 + 2.1)
	const total = 0.18 + wave * 0.45
	const warn = total * (0.08 + 0.1 * (0.5 + 0.5 * Math.sin(t * Math.PI * 5.7 + 1.3)))
	// Errors cluster: a few columns carry a cap, most carry none.
	const errorPulse = Math.max(0, Math.sin(t * Math.PI * 9.4 + 0.4) - 0.55)
	const error = total * errorPulse * 0.5
	return [
		{ severity: "INFO", height: total - warn - error },
		{ severity: "WARN", height: warn },
		{ severity: "ERROR", height: error },
	]
})

export interface EmptyLogVolumeStripProps {
	/** The window the user asked for (unpadded), epoch ms. */
	startMs: number
	endMs: number
	/** The bucket width the real strip would use, for tick label granularity. */
	bucketSeconds: number
	stale?: boolean
}

/**
 * What the volume strip shows when the window holds no logs.
 *
 * Rather than collapsing to nothing — which moves the list up the page and
 * back down again the moment a log arrives — keep the strip's height and
 * gutter and use the space to say what it is: the window along the baseline,
 * a ghost of the stacked columns, and the severities it stacks, coloured with
 * the same `getSeverityColor` the real bands and the facet swatches use.
 */
export function EmptyLogVolumeStrip({ startMs, endMs, bucketSeconds, stale }: EmptyLogVolumeStripProps) {
	const rangeMs = Math.max(0, endMs - startMs)
	const axisContext = { rangeMs, bucketSeconds }
	const ticks = Array.from({ length: EMPTY_STRIP_TICKS }, (_, i) => {
		const ms = startMs + (rangeMs * i) / (EMPTY_STRIP_TICKS - 1)
		return {
			label: formatBucketLabel(toClickHouseDateTime(ms), axisContext, "tick"),
			left: (i / (EMPTY_STRIP_TICKS - 1)) * 100,
		}
	})

	return (
		<div
			role="img"
			aria-label="Log volume by severity, no logs in the selected range"
			className={cn(
				"flex w-full select-none text-muted-foreground transition-opacity",
				stale && "opacity-60",
			)}
			style={{ height: PLOT_HEIGHT + AXIS_HEIGHT, paddingRight: RIGHT_PAD }}
		>
			<div
				className="flex shrink-0 flex-col justify-end pr-1.5 text-right text-[9px] leading-none tabular-nums"
				style={{ width: Y_GUTTER, paddingBottom: AXIS_HEIGHT }}
			>
				0
			</div>
			<div className="relative flex min-w-0 flex-1 flex-col">
				<div className="relative" style={{ height: PLOT_HEIGHT }}>
					<div
						className="absolute inset-x-0 border-t border-dashed border-border/60"
						style={{ top: TOP_PAD }}
					/>
					<div className="absolute inset-x-0 top-1/2 border-t border-dashed border-border/60" />
					<div aria-hidden className="absolute inset-0 flex items-end gap-px opacity-[0.18]">
						{EMPTY_STRIP_COLUMNS.map((slices, i) => (
							<div key={i} className="flex h-full min-w-0 flex-1 flex-col-reverse">
								{slices.map((slice) => (
									<div
										key={slice.severity}
										style={{
											height: `${slice.height * 100}%`,
											backgroundColor: getSeverityColor(slice.severity),
										}}
									/>
								))}
							</div>
						))}
					</div>
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
						<span className="text-xs">No log volume in this window</span>
						<ul className="flex items-center gap-3 text-[10px] uppercase tracking-wide opacity-60">
							{EMPTY_STRIP_LEGEND.map((severity) => (
								<li key={severity} className="flex items-center gap-1.5">
									<span
										className="size-1.5 rounded-[2px]"
										style={{ backgroundColor: getSeverityColor(severity) }}
									/>
									{severity}
								</li>
							))}
						</ul>
					</div>
				</div>
				<div className="relative border-t border-border" style={{ height: AXIS_HEIGHT }}>
					{ticks.map((tick, i) => (
						<span
							key={i}
							className="absolute top-1 whitespace-nowrap text-[9px] leading-none tabular-nums"
							style={{
								left: `${tick.left}%`,
								transform:
									i === 0
										? "none"
										: i === ticks.length - 1
											? "translateX(-100%)"
											: "translateX(-50%)",
							}}
						>
							{tick.label}
						</span>
					))}
				</div>
			</div>
		</div>
	)
}
