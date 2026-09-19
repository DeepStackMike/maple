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
