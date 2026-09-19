// The Analytics tab's Web section: how much traffic the browser SDK recorded,
// what it read, and where it came from.
//
// Eight queries back the whole thing, and two of them are somebody else's — the
// summary is Home's and the error count is the sessions tab's (see
// `use-local-web-analytics.ts`). The rest is the KPI strip, one chart, nine
// ranked tables cut from a single facet union, and two — Regions and Cities —
// that read a key of the session's resource map and so cost a query each.
//
// The one piece of URL state is which UTM dimension the acquisition card shows;
// the view owns it, the same way it owns the product panel's property key.

import { useMemo, type ReactNode } from "react"
import { EyeIcon } from "@maple/ui/components/icons"
import { NativeSelect, NativeSelectOption } from "@maple/ui/components/ui/native-select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { QueryBuilderLineChart } from "@maple/ui/components/charts/line/query-builder-line-chart"
import { formatNumber } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { cn } from "@maple/ui/lib/utils"
import { useLocalSessionsSummary } from "../hooks/use-local-home"
import { useLocalSessionFacets } from "../hooks/use-local-sessions"
import {
	useLocalSessionAttributeBreakdown,
	useLocalWebBreakdowns,
	useLocalWebPages,
	useLocalWebPageviewsTimeseries,
	useLocalWebSessionsTimeseries,
} from "../hooks/use-local-web-analytics"
import { countryLabel } from "../lib/geo"
import { formatPercent } from "../lib/product-analytics"
import { navigate } from "../lib/router"
import {
	bounceRate,
	hasVisitorCoverage,
	referrerLabel,
	totalPageViews,
	trafficSeries,
	utmLabel,
	withShares,
	type BreakdownRow,
} from "../lib/web-analytics"
import { VisitorMap } from "./visitor-map"
import { EmptyState, ErrorState, ListSkeleton } from "./view-states"

/** The three acquisition tags, behind one selector rather than three near-identical cards. */
const UTM_DIMENSIONS = [
	{ key: "utmSource", label: "Source" },
	{ key: "utmMedium", label: "Medium" },
	{ key: "utmCampaign", label: "Campaign" },
] as const

type UtmDimension = (typeof UTM_DIMENSIONS)[number]["key"]

const DEFAULT_UTM_DIMENSION: UtmDimension = "utmSource"

/**
 * Why Entries and Exits are usually empty in Local, said once.
 *
 * `EntryPath` / `ExitPath` are migration-0011 columns on `session_replays`, so
 * they are populated by the SDK build that writes the analytics block — not by
 * page views, which the Top pages card reads straight off `session_events` and
 * which therefore stay populated either way. Without this line the two cards
 * side by side read as a contradiction.
 */
const ANALYTICS_BLOCK_HINT =
	"Not recorded. Entry and exit paths come from the session's analytics block, which the browser SDK writes only when it is tracking a visitor."

/**
 * The two geography dimensions below Country, as OpenTelemetry names them.
 *
 * `Country` is a `session_replays` column the ingest gateway fills from one
 * edge header; region and city are not columns at all — the ingest sidecar
 * writes them into the session's `ResourceAttributes` under these keys, so each
 * card is its own query rather than another branch of the facet union.
 *
 * Regions carry their country: `TX` and `NRW` are ISO 3166-2 subdivision codes,
 * unique only within a country, and the builder pairs them into `US-TX` on the
 * same scan.
 */
const GEO_REGION = { key: "geo.region.iso_code", qualifierKey: "geo.country.iso_code" } as const
const GEO_CITY = { key: "geo.locality.name" } as const

/**
 * Both keys come from the same place — the edge's visitor location headers —
 * so an empty Regions card and an empty Cities card have the same one cause and
 * say so identically.
 */
const GEO_HEADER_HINT = "Enable Cloudflare's visitor location headers on the ingest hostname."

/** Clamps a hand-edited `utm` param to one of the three. */
export function parseUtmDimension(raw: string | null | undefined): UtmDimension {
	return UTM_DIMENSIONS.find((dimension) => dimension.key === raw)?.key ?? DEFAULT_UTM_DIMENSION
}

interface WebAnalyticsPanelProps {
	range: string
	/** Which `utm_*` dimension the acquisition card lists. */
	utm: UtmDimension
	onUtmChange: (next: UtmDimension) => void
}

export function WebAnalyticsPanel({ range, utm, onUtmChange }: WebAnalyticsPanelProps) {
	// Home's hook and the sessions tab's hook, called with this page's range —
	// same objects they build, so these two are cache hits whenever the user
	// arrived from either.
	const summary = useLocalSessionsSummary(range)
	const facets = useLocalSessionFacets({ errorsOnly: false, range })
	const sessionsTimeseries = useLocalWebSessionsTimeseries(range)
	const pageviewsTimeseries = useLocalWebPageviewsTimeseries(range)
	const pages = useLocalWebPages(range)
	const breakdowns = useLocalWebBreakdowns(range)
	const regions = useLocalSessionAttributeBreakdown(range, GEO_REGION)
	const cities = useLocalSessionAttributeBreakdown(range, GEO_CITY)

	const sessionPoints = sessionsTimeseries.data ?? []
	const pageviewPoints = pageviewsTimeseries.data ?? []
	const chartRows = useMemo(
		() => trafficSeries(sessionPoints, pageviewPoints),
		[sessionPoints, pageviewPoints],
	)
	// A failed query is not a zero. Page views come from their own table and
	// their own round trip, so the strip reports them as unmeasured when that
	// round trip failed rather than rendering a confident 0 next to a populated
	// session count — the same rule the visitor tile follows for a different
	// reason.
	const pageViews = pageviewsTimeseries.isError ? null : totalPageViews(pageviewPoints)
	const errorSessions = facets.isError ? null : (facets.data?.errorCount ?? 0)

	const facet = (facetType: string): BreakdownRow[] => withShares(breakdowns.data?.get(facetType) ?? [])

	const pageRows = useMemo(
		() => withShares((pages.data ?? []).map((page) => ({ name: page.pagePath, count: page.pageViews }))),
		[pages.data],
	)
	const regionRows = useMemo(() => withShares(regions.data ?? []), [regions.data])
	const cityRows = useMemo(() => withShares(cities.data ?? []), [cities.data])

	// Carry the range onto every outbound link, exactly as Home does: the
	// sessions list defaults to 30 days and this tab may be showing one hour, so
	// an unqualified link would silently widen and disagree with the row that
	// sent the user there.
	const openSessions = (params: Record<string, string>) =>
		navigate("/sessions", new URLSearchParams({ range, ...params }))

	if (summary.isPending) return <ListSkeleton rows={6} />
	if (summary.isError) {
		return <ErrorState label="web analytics" error={summary.error} onRetry={() => summary.refetch()} />
	}

	const row = summary.data
	const sessions = row?.sessions ?? 0

	if (sessions === 0) {
		return (
			<EmptyState
				icon={<EyeIcon />}
				title="No browser sessions yet"
				hint={
					<>
						Web analytics is read from the sessions the browser SDK records. Install{" "}
						<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em]">
							@maple/browser
						</code>{" "}
						in a page and load it once, or widen the time range if you already have.
					</>
				}
			/>
		)
	}

	const bounce = row ? bounceRate(row) : null
	const visitorsKnown = row ? hasVisitorCoverage(row) : false

	return (
		<section className="space-y-6">
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
				<StatTile
					label="Sessions"
					value={formatNumber(sessions)}
					hint="recorded"
					onClick={() => openSessions({})}
				/>
				<StatTile
					label="Page views"
					value={pageViews === null ? "—" : formatNumber(pageViews)}
					hint={pageViews === null ? "query failed" : "across every session"}
					unavailable={pageViews === null}
				/>
				<StatTile
					label="Avg. session"
					value={formatSessionDuration(row?.avgDurationMs ?? 0)}
					hint="sessions that ended"
				/>
				<StatTile
					label="Bounce rate"
					value={bounce === null ? "—" : formatPercent(bounce)}
					hint={
						bounce === null
							? "needs a visitor id"
							: `of ${formatNumber(row?.identifiedSessions ?? 0)} reporting sessions`
					}
					unavailable={bounce === null}
				/>
				<StatTile
					label="With errors"
					value={errorSessions === null ? "—" : formatNumber(errorSessions)}
					hint="sessions"
					danger={(errorSessions ?? 0) > 0}
					unavailable={errorSessions === null}
					onClick={errorSessions === null ? undefined : () => openSessions({ errors: "1" })}
				/>
				{/* Visitors is the one headline Local usually cannot answer: the
				    browser SDK runs with `persistVisitorId: false`, so `VisitorId` is
				    empty on every row and `uniq()` over it is 0. A confident zero
				    beside a populated Sessions tile reads as "nobody came", which is
				    the opposite of true — so the tile says it is unmeasured instead. */}
				<StatTile
					label="Visitors"
					value={visitorsKnown ? formatNumber(row?.visitors ?? 0) : "—"}
					hint={visitorsKnown ? "distinct browsers" : "no visitor id in range"}
					unavailable={!visitorsKnown}
				/>
			</div>

			<Card title="Traffic">
				{/* Either failure takes the whole chart, not just its own line: a
				    series drawn flat along the axis under a legend that names it is
				    read as "none of these", which is not what a failed query means. */}
				{sessionsTimeseries.isError || pageviewsTimeseries.isError ? (
					<ErrorState
						label="the traffic chart"
						error={sessionsTimeseries.error ?? pageviewsTimeseries.error}
						onRetry={() => {
							void sessionsTimeseries.refetch()
							void pageviewsTimeseries.refetch()
						}}
					/>
				) : chartRows.length < 2 ? (
					<Hint>Not enough buckets to chart this range yet.</Hint>
				) : (
					<div className="p-3">
						<QueryBuilderLineChart
							data={chartRows}
							className="h-56 w-full"
							legend="visible"
							tooltip="visible"
							curveType="monotone"
						/>
					</div>
				)}
			</Card>

			{breakdowns.isError ? (
				<ErrorState
					label="the breakdowns"
					error={breakdowns.error}
					onRetry={() => breakdowns.refetch()}
				/>
			) : (
				<div className="space-y-6">
					{/* The Countries card's own rows, drawn. Inside the union's error
					    branch rather than above it, so a failed breakdown query is
					    still one message on the page and not two. */}
					<Card title="Where visitors come from">
						<VisitorMap
							countries={facet("country")}
							regions={regionRows}
							pending={breakdowns.isPending}
						/>
					</Card>

					{/* `items-start` so a Devices card with three rows is not stretched
					    to the height of a Pages card with fifty. */}
					<div className="grid items-start gap-4 lg:grid-cols-2">
						<BreakdownCard
							title="Top pages"
							unit="Views"
							rows={pageRows}
							pending={pages.isPending}
							empty="No page views in this range."
						/>
						<BreakdownCard
							title="Entry pages"
							rows={facet("entryPath")}
							pending={breakdowns.isPending}
							empty={ANALYTICS_BLOCK_HINT}
						/>
						<BreakdownCard
							title="Exit pages"
							rows={facet("exitPath")}
							pending={breakdowns.isPending}
							empty={ANALYTICS_BLOCK_HINT}
						/>
						<BreakdownCard
							title="Referrers"
							rows={facet("referrerHost")}
							pending={breakdowns.isPending}
							format={referrerLabel}
							empty="No referrer recorded in this range."
						/>
						<BreakdownCard
							title="Campaigns"
							rows={facet(utm)}
							pending={breakdowns.isPending}
							format={utmLabel}
							empty="No utm_* tag recorded in this range."
							action={
								<NativeSelect
									size="sm"
									aria-label="UTM dimension"
									value={utm}
									onChange={(e) => onUtmChange(parseUtmDimension(e.target.value))}
								>
									{UTM_DIMENSIONS.map((dimension) => (
										<NativeSelectOption key={dimension.key} value={dimension.key}>
											{dimension.label}
										</NativeSelectOption>
									))}
								</NativeSelect>
							}
						/>
						<BreakdownCard
							title="Browsers"
							rows={facet("browserName")}
							pending={breakdowns.isPending}
							onRowClick={(name) => openSessions({ browser: name })}
							empty="No browser recorded in this range."
						/>
						{/* The one dimension on the page with no outbound link:
					    `sessionReplaysListQuery` takes `browser` and `deviceType` but
					    has no `osName` filter, so there is no sessions URL to send this
					    row to. Adding one is a query-engine change plus a facet section
					    on the sessions sidebar — a separate change from this page. */}
						<BreakdownCard
							title="Operating systems"
							rows={facet("osName")}
							pending={breakdowns.isPending}
							empty="No OS recorded in this range."
						/>
						<BreakdownCard
							title="Devices"
							rows={facet("deviceType")}
							pending={breakdowns.isPending}
							onRowClick={(name) => openSessions({ device: name })}
							empty="No device type recorded in this range."
						/>
						<BreakdownCard
							title="Countries"
							rows={facet("country")}
							pending={breakdowns.isPending}
							format={countryLabel}
							empty="No geo data. Country is resolved at the ingest gateway from an edge header, which local mode does not set."
						/>
						{/* Region and city ride their own queries, so they carry their own
					    pending and error states rather than the union's. */}
						<BreakdownCard
							title="Regions"
							rows={regionRows}
							pending={regions.isPending}
							error={regions.isError ? regions.error : undefined}
							onRetry={() => regions.refetch()}
							empty={`No region data. ${GEO_HEADER_HINT}`}
						/>
						<BreakdownCard
							title="Cities"
							rows={cityRows}
							pending={cities.isPending}
							error={cities.isError ? cities.error : undefined}
							onRetry={() => cities.refetch()}
							empty={`No city data. ${GEO_HEADER_HINT}`}
						/>
					</div>
				</div>
			)}
		</section>
	)
}

/**
 * A KPI tile. Its own component rather than Home's, which is a strictly weaker
 * shape: every tile there is a link, and none of them can be *unmeasured*. Half
 * the numbers here have no destination, and two of them are unknown in Local
 * rather than zero — which is a rendering state, not a value.
 */
function StatTile({
	label,
	value,
	hint,
	danger,
	unavailable,
	onClick,
}: {
	label: string
	value: string
	hint: string
	danger?: boolean
	/** Greys the value: this number is unknown for this window, not zero. */
	unavailable?: boolean
	onClick?: () => void
}) {
	const body = (
		<>
			<div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
				{label}
			</div>
			<div
				className={cn(
					"text-lg font-semibold tabular-nums",
					danger && "text-destructive",
					unavailable && "text-muted-foreground",
				)}
			>
				{value}
			</div>
			<div className="truncate text-[10px] text-muted-foreground" title={hint}>
				{hint}
			</div>
		</>
	)

	if (!onClick) return <div className="rounded-md border bg-card px-3 py-2 text-left">{body}</div>
	return (
		<button
			type="button"
			onClick={onClick}
			className="rounded-md border bg-card px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			{body}
		</button>
	)
}

/**
 * One ranked dimension: value, count, and share of the listed total.
 *
 * The share is deliberately of what the card lists rather than of all sessions
 * — the branch behind it returns a top-N and drops the rows that never
 * populated the column, so this is the only denominator a reader can check by
 * adding the column up. See `withShares`.
 */
function BreakdownCard({
	title,
	unit = "Sessions",
	rows,
	pending,
	empty,
	error,
	onRetry,
	format,
	onRowClick,
	action,
}: {
	title: string
	/** Header of the count column — page views for Top pages, sessions everywhere else. */
	unit?: string
	rows: ReadonlyArray<BreakdownRow>
	pending: boolean
	empty: string
	/**
	 * Set when this card has its own query and that query failed. Cards cut from
	 * the facet union leave it unset — one failed union is one error above the
	 * grid, not nine identical ones inside it.
	 */
	error?: unknown
	onRetry?: () => void
	format?: (value: string) => string
	/** Makes each row a link into the sessions list, filtered on this value. */
	onRowClick?: (name: string) => void
	action?: ReactNode
}) {
	return (
		<Card title={title} action={action}>
			{/* A failed query is not an empty dimension: rendering the empty hint
			    here would tell the reader to go and enable a header that is already
			    on. Same rule the KPI tiles follow. */}
			{error !== undefined ? (
				<ErrorState label={title.toLowerCase()} error={error} onRetry={onRetry} />
			) : pending ? (
				<ListSkeleton rows={4} />
			) : rows.length === 0 ? (
				<Hint>{empty}</Hint>
			) : (
				<div className="max-h-80 overflow-auto">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{title}</TableHead>
								<TableHead className="text-right">{unit}</TableHead>
								<TableHead className="text-right">Share</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((row) => (
								<TableRow
									key={row.name}
									onClick={onRowClick ? () => onRowClick(row.name) : undefined}
									className={cn(onRowClick && "cursor-pointer")}
								>
									<TableCell className="max-w-0">
										<span className="block truncate" title={row.name}>
											{format ? format(row.name) : row.name}
										</span>
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{row.count.toLocaleString()}
									</TableCell>
									<TableCell className="text-right tabular-nums text-muted-foreground">
										{formatPercent(row.share)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</Card>
	)
}

function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
	return (
		<section className="space-y-2">
			<div className="flex min-h-8 items-center justify-between gap-3">
				<h3 className="text-sm font-medium">{title}</h3>
				{action}
			</div>
			<div className="overflow-hidden rounded-md border bg-card">{children}</div>
		</section>
	)
}

function Hint({ children }: { children: ReactNode }) {
	return <p className="px-4 py-6 text-center text-sm text-muted-foreground">{children}</p>
}
