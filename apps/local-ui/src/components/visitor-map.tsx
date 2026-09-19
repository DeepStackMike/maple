// Where the sessions came from, as a map.
//
// It draws the Countries breakdown the card below it lists — the same query,
// the same rows, the same shares — because the two answer different questions
// about one number. The card answers "which country is biggest"; the map
// answers "is this one country or a continent", which is the question a site
// owner opens Analytics with and the one a ranked list is worst at.
//
// The regions in the tooltip are free: the Regions card already ran that query
// and its rows are qualified (`US-TX`), so picking one country's subdivisions
// out of them costs a `startsWith`. Cities are not there, and cannot be — that
// query carries no country qualifier, so nothing in the response says which
// country a `Springfield` belongs to.
//
// Two files and one dependency behind it: `react-simple-maps/core` (projection
// and path generation, the `core` entry so the pan/zoom half and its `d3-zoom`
// are never pulled in), and `src/assets/countries-110m.json` — the Natural
// Earth outlines vendored from `world-atlas`, loaded from our own origin as a
// static asset. Never from a CDN: local mode runs on a laptop with no internet
// and a map that blanks out offline is worse than no map.

import { memo, useCallback, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { ComposableMap, Geographies, Geography } from "react-simple-maps/core"
import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import atlasUrl from "../assets/countries-110m.json?url"
import { formatPercent } from "../lib/product-analytics"
import { countryLabel } from "../lib/geo"
import type { BreakdownRow } from "../lib/web-analytics"
import {
	ANTARCTICA_ID,
	MAP_EMPTY_FILL_CLASS,
	alpha2ForOutline,
	fillClassForStep,
	regionsIn,
	shadeWorld,
	stepLabel,
	unmappedCountries,
	type ShadedCountry,
	type WorldShading,
} from "../lib/world-map"
import { ErrorState, ListSkeleton } from "./view-states"

/**
 * The frame the outlines are projected into, in the SVG's own units — the map
 * is sized by its `viewBox` and stretches to the card, so these are a shape,
 * not a size.
 *
 * Equal Earth rather than the web's usual Mercator: this is a quantity per
 * country, and Mercator ends an argument about Greenland and Africa before it
 * starts. At scale 150 the projected world is 796 units wide, which fills the
 * 800 exactly; the unused band at the bottom is Antarctica's, and Antarctica is
 * dropped.
 */
const FRAME = { width: 800, height: 400, scale: 150 } as const

/** How many subdivisions a tooltip lists before it is a table rather than a hint. */
const TOOLTIP_REGIONS = 3

/** Half the tooltip's own width, so it can be kept inside the card. */
const TOOLTIP_REACH = 112

/**
 * Said when the map is empty, which in local mode is the normal case.
 *
 * `Country` is resolved at the ingest gateway from `CF-IPCountry`, so a session
 * posted straight to `maple start` has none — and the fix is a deployment fact,
 * not anything to click here.
 */
const NO_LOCATION_HINT =
	"No location data yet. Sessions get a country once the ingest hostname is behind Cloudflare with geolocation on."

/** The atlas as `Geographies` takes it, without naming the GeoJSON types through a transitive dependency. */
type Atlas = Exclude<ComponentProps<typeof Geographies>["geography"], string>

/**
 * Antarctica is a tenth of the frame and none of the traffic.
 *
 * Module scope, not a closure: `useGeographies` re-parses the whole atlas when
 * this identity changes.
 */
const withoutAntarctica = <T extends { id?: string | number }>(features: T[]): T[] =>
	features.filter((feature) => feature.id !== ANTARCTICA_ID)

interface VisitorMapProps {
	/** The `country` facet, already ranked and shared — the Countries card's own rows. */
	countries: ReadonlyArray<BreakdownRow>
	/** The Regions card's rows, qualified `US-TX`. Empty until the sidecar writes them. */
	regions: ReadonlyArray<BreakdownRow>
	pending: boolean
}

export function VisitorMap({ countries, regions, pending }: VisitorMapProps) {
	// The outlines are a 105 KB asset, not part of the JS bundle, so fetching
	// them is a query like any other — which buys the skeleton, the retry and
	// the cache across range changes for free. `Infinity` because a map of the
	// world does not go stale.
	const atlas = useQuery({
		queryKey: ["local", "world-atlas"],
		queryFn: async (): Promise<Atlas> => {
			const response = await fetch(atlasUrl)
			if (!response.ok) throw new Error(`Couldn’t load the world map (${response.status})`)
			return (await response.json()) as Atlas
		},
		staleTime: Infinity,
		gcTime: Infinity,
	})

	const shading = useMemo(() => shadeWorld(countries), [countries])
	const unmapped = useMemo(() => unmappedCountries(countries), [countries])

	// Hover lives here and the outlines live behind a `memo`, so moving the
	// pointer across the map re-renders one tooltip rather than 176 paths.
	const [hovered, setHovered] = useState<string | null>(null)
	const [pointer, setPointer] = useState({ x: 0, y: 0 })
	const frameRef = useRef<HTMLDivElement>(null)

	const onEnter = useCallback((code: string) => setHovered(code), [])
	const onLeave = useCallback(() => setHovered(null), [])
	const onMove = useCallback((clientX: number, clientY: number) => {
		const frame = frameRef.current?.getBoundingClientRect()
		if (!frame) return
		// Clamped so a tooltip over New Zealand stays in the card.
		setPointer({
			x: Math.min(Math.max(clientX - frame.left, TOOLTIP_REACH), frame.width - TOOLTIP_REACH),
			y: clientY - frame.top,
		})
	}, [])

	if (pending || atlas.isPending) return <ListSkeleton rows={5} />
	if (atlas.isError) {
		return <ErrorState label="the world map" error={atlas.error} onRetry={() => atlas.refetch()} />
	}
	if (countries.length === 0) return <Hint>{NO_LOCATION_HINT}</Hint>

	const country = hovered ? shading.byCode.get(hovered) : undefined

	return (
		<div className="space-y-3 p-3">
			<div ref={frameRef} className="relative" onMouseLeave={onLeave}>
				<Outlines
					atlas={atlas.data}
					shading={shading}
					onEnter={onEnter}
					onLeave={onLeave}
					onMove={onMove}
				/>
				{hovered ? (
					<Tooltip
						code={hovered}
						country={country}
						regions={regionsIn(regions, hovered, TOOLTIP_REGIONS)}
						x={pointer.x}
						y={pointer.y}
					/>
				) : null}
			</div>

			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
				<Legend shading={shading} />
				{unmapped.length > 0 ? (
					// The map's shades add up to less than the card below it, and this
					// is the whole reason: island states have no outline at 110m, and
					// `XX` (address not placed) and `T1` (Tor) are not countries at all.
					<p className="text-[10px] text-muted-foreground">
						{formatNumber(unmapped.reduce((total, row) => total + row.count, 0))} of{" "}
						{formatNumber(shading.totalSessions)} sessions aren’t on the map:{" "}
						{unmapped
							.slice(0, 6)
							.map((row) => row.name)
							.join(", ")}
						{unmapped.length > 6 ? ` +${unmapped.length - 6} more` : ""}
					</p>
				) : null}
			</div>
		</div>
	)
}

/**
 * The outlines themselves.
 *
 * `memo`, and every prop stable, for two reasons that both bite on hover.
 * `useGeographies` re-runs `JSON.stringify` over the whole atlas on each render
 * to decide whether its `geography` prop changed, and the 176 paths below are
 * rebuilt with it. Neither has anything to say about which country the pointer
 * is over, so neither runs: this subtree renders when the breakdown changes,
 * and the hover highlight is a CSS `:hover` rule rather than a React state.
 */
const Outlines = memo(function Outlines({
	atlas,
	shading,
	onEnter,
	onLeave,
	onMove,
}: {
	atlas: Atlas
	shading: WorldShading
	onEnter: (code: string) => void
	onLeave: () => void
	onMove: (clientX: number, clientY: number) => void
}) {
	return (
		<ComposableMap
			width={FRAME.width}
			height={FRAME.height}
			projection="geoEqualEarth"
			projectionConfig={{ scale: FRAME.scale }}
			className="h-auto w-full"
			role="img"
			aria-label="Sessions by country. The same figures are listed in the Countries table below."
		>
			<Geographies geography={atlas} parseGeographies={withoutAntarctica}>
				{({ geographies }) =>
					geographies.map((geography) => {
						const name = (geography.properties as { name?: string } | null)?.name ?? ""
						const code = alpha2ForOutline(geography.id, name)
						const step = code ? (shading.byCode.get(code)?.step ?? -1) : -1
						return (
							<Geography
								key={geography.rsmKey}
								geography={geography}
								// `tabIndex` overrides the library's own 0: 176 tab stops
								// in front of the table that already carries the numbers is
								// not a keyboard path anybody wants.
								tabIndex={-1}
								className={cn(
									"stroke-background [stroke-width:0.5] outline-none",
									// Non-scaling so the hairline stays a hairline on a wide
									// card, where one SVG unit is more than one pixel.
									"[vector-effect:non-scaling-stroke]",
									fillClassForStep(shading.scale, step),
									code && "hover:stroke-foreground hover:[stroke-width:1.25]",
								)}
								onMouseEnter={code ? () => onEnter(code) : onLeave}
								// Per outline, not on the frame: the sea between two
								// countries is not a path, and without this the tooltip
								// would follow the pointer out over the Atlantic.
								onMouseLeave={onLeave}
								onMouseMove={
									code ? (event) => onMove(event.clientX, event.clientY) : undefined
								}
							/>
						)
					})
				}
			</Geographies>
		</ComposableMap>
	)
})

/**
 * The hovered country.
 *
 * Every outline the atlas can name gets one, including the ones with no
 * sessions: a reader who points at a blank country is asking whether it is
 * blank because nobody came or because we could not tell, and "no sessions" is
 * the answer to the first.
 */
function Tooltip({
	code,
	country,
	regions,
	x,
	y,
}: {
	code: string
	country: ShadedCountry | undefined
	regions: ReadonlyArray<BreakdownRow>
	x: number
	y: number
}) {
	return (
		<div
			className="pointer-events-none absolute z-10 w-56 -translate-x-1/2 -translate-y-[calc(100%+12px)] rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
			style={{ left: x, top: y }}
		>
			<div className="truncate font-medium">{countryLabel(code)}</div>
			{country ? (
				<div className="text-muted-foreground tabular-nums">
					{formatNumber(country.count)} {country.count === 1 ? "session" : "sessions"} ·{" "}
					{formatPercent(country.share)} of located traffic
				</div>
			) : (
				<div className="text-muted-foreground">No sessions in this range</div>
			)}
			{regions.length > 0 ? (
				<ul className="mt-1 space-y-0.5 border-t pt-1 text-muted-foreground">
					{regions.map((region) => (
						<li key={region.name} className="flex justify-between gap-2">
							<span className="truncate">{region.name}</span>
							<span className="tabular-nums">{formatNumber(region.count)}</span>
						</li>
					))}
				</ul>
			) : null}
		</div>
	)
}

/**
 * The scale, as ranges of sessions rather than as a gradient bar.
 *
 * The breaks are quantiles of the countries that reported, so they are not
 * evenly spaced and a gradient would misstate them; printing each step's own
 * range is the only rendering that cannot lie about what a shade means. Each
 * swatch is the map's fill class on a one-unit rect, so the legend cannot drift
 * from the map.
 */
function Legend({ shading }: { shading: WorldShading }) {
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
			<span className="uppercase tracking-wider">Sessions</span>
			{shading.scale.map((step, index) => (
				<span key={step.min} className="flex items-center gap-1 tabular-nums">
					<Swatch className={fillClassForStep(shading.scale, index)} />
					{stepLabel(step)}
				</span>
			))}
			<span className="flex items-center gap-1">
				<Swatch className={MAP_EMPTY_FILL_CLASS} />
				None
			</span>
		</div>
	)
}

function Swatch({ className }: { className: string }) {
	return (
		<svg viewBox="0 0 1 1" className="size-2.5 rounded-[2px] border" aria-hidden="true">
			<rect width="1" height="1" className={className} />
		</svg>
	)
}

function Hint({ children }: { children: ReactNode }) {
	return <p className="px-4 py-6 text-center text-sm text-muted-foreground">{children}</p>
}
