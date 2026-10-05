import { useState, type ReactNode } from "react"
import { Spinner } from "@maple/ui/components/ui/spinner"
import {
	ChevronRightIcon,
	ClockIcon,
	CircleWarningIcon,
	ComputerIcon,
	EyeIcon,
	GlobeIcon,
	MobileIcon,
	PulseIcon,
} from "@maple/ui/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"
import { useLocalSessions, useLocalSessionFacets, type SessionListRow } from "../hooks/use-local-sessions"
import { useLiveClock } from "../hooks/use-live-clock"
import { useEnvironment } from "../hooks/use-environment"
import { useRange } from "../hooks/use-range"
import { useTimeWindow } from "../hooks/use-time-window"
import { countryLabel, countryName, flagEmoji } from "../lib/geo"
import { hrefFor, useQueryParams } from "../lib/router"
import { formatLocalDateTime, formatRelativeTime, formatUtcTitle, WIDEST_RANGE } from "../lib/time"
import {
	formatSessionDuration,
	gradientFor,
	hostFromUrl,
	isMobileDevice,
	isSessionLive,
	sessionDurationMs,
} from "@maple/ui/lib/replay-format"
import { sessionListItems } from "../lib/session-list-items"
import {
	asSessionTag,
	isQualityTier,
	nextTagSelection,
	SESSION_TAG_DESCRIPTIONS,
	SESSION_TAG_DOTS,
	SESSION_TAG_LABELS,
	SESSION_TAG_ORDER,
	SESSION_TAG_STYLES,
	sessionTagsFromParam,
	sessionTagsToParam,
	type SessionTag,
} from "../lib/session-tags"
import {
	FilterSection,
	SearchableFilterSection,
	SingleCheckboxFilter,
	type FilterOption,
} from "@maple/ui/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import { PageShell } from "../components/page-shell"
import {
	Toolbar,
	ToolbarSearch,
	ToolbarStat,
	ToolbarStats,
	TimeRangeSelect,
	RefreshButton,
} from "../components/toolbar"
import { SignalEmptyState } from "../components/signal-empty-state"
import { ErrorState, ListSkeleton } from "../components/view-states"

/** Re-inject a selected value that the server-side facet branch excluded. */
function withSelected(options: ReadonlyArray<FilterOption>, selected?: string): FilterOption[] {
	const list = options.map((o) => ({ name: o.name, count: o.count }))
	if (selected && !list.some((o) => o.name === selected)) list.unshift({ name: selected, count: 0 })
	return list
}

// Every tag in a fixed order, counts filled from the facet. Each count is taken
// under the other selected tags, so it reads as "sessions you would get by ticking it".
function tagOptions(counts: ReadonlyArray<FilterOption>): FilterOption[] {
	return SESSION_TAG_ORDER.map((tag) => ({
		name: tag,
		count: counts.find((item) => item.name === tag)?.count ?? 0,
	}))
}

const tagLabel = (name: string) => {
	const tag = asSessionTag(name)
	return tag === undefined ? name : SESSION_TAG_LABELS[tag]
}

// The same colour the tag's pill has on the cards, so the two read as one vocabulary.
const tagDot = (name: string) => {
	const tag = asSessionTag(name)
	if (tag === undefined) return undefined
	return <span aria-hidden className={cn("size-2 shrink-0 rounded-full", SESSION_TAG_DOTS[tag])} />
}

const tagDescription = (name: string) => {
	const tag = asSessionTag(name)
	return tag === undefined ? undefined : SESSION_TAG_DESCRIPTIONS[tag]
}

const CLEARED_FILTERS = {
	service: null,
	browser: null,
	device: null,
	country: null,
	page: null,
	tags: null,
	errors: null,
} as const

export function SessionsListView() {
	const [query, setParams] = useQueryParams()
	const [range, setRange] = useRange()
	const timeWindow = useTimeWindow(range)
	const service = query.get("service") || undefined
	const browser = query.get("browser") || undefined
	const device = query.get("device") || undefined
	const country = query.get("country") || undefined
	const pagePath = query.get("page") || undefined
	// Comma-separated in the hash; unknown names are dropped, so a hand-edited URL
	// cannot send the query a tag it does not know.
	const selectedTags = sessionTagsFromParam(query.get("tags"))
	const errorsOnly = query.get("errors") === "1"
	const search = query.get("q") || undefined
	// From the header, not a sidebar section: the environment says which
	// deployment the whole session is about. `useLocalSessions` has carried the
	// option since the header shipped; this view was the one that never passed
	// it, so a header reading `production` sat above a list showing every
	// deployment — `unknown` included.
	const [env] = useEnvironment()

	const filters = {
		service,
		browser,
		device,
		country,
		pagePath,
		tags: selectedTags,
		errorsOnly,
		search,
		env,
	}
	const facets = useLocalSessionFacets(filters, timeWindow.bounds)
	const list = useLocalSessions(filters, timeWindow.bounds)
	const { isPending, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = list
	const sessions = list.data?.pages.flat() ?? []

	const setSingle = (key: string, vals: string[]) => setParams({ [key]: vals.at(-1) ?? null })
	const setTags = (values: string[]) =>
		setParams({ tags: sessionTagsToParam(nextTagSelection(selectedTags, values)) })
	const addTag = (tag: SessionTag) => setTags([...selectedTags, tag])
	const activeFilterCount =
		[service, browser, device, country, pagePath, errorsOnly].filter(Boolean).length + selectedTags.length
	const hasActiveFilters = activeFilterCount > 0
	const facetData = facets.data
	// A tier filter already decided what to show; folding its rows would hide the answer.
	const collapseLowSignal = !selectedTags.some(isQualityTier)
	// Only sessions still reading `"active"` can cross the live boundary while the
	// list sits open; a page of ended ones needs no timer at all.
	const nowMs = useLiveClock({ enabled: sessions.some((session) => session.status === "active") })
	const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<string>>(() => new Set())
	const items = sessionListItems(sessions, { collapse: collapseLowSignal, expanded: expandedRuns, nowMs })
	const toggleRun = (key: string) =>
		setExpandedRuns((previous) => {
			const next = new Set(previous)
			if (!next.delete(key)) next.add(key)
			return next
		})

	const sidebar = (
		<FilterSidebarFrame className="w-56 shrink-0 px-4" waiting={facets.isFetching}>
			<FilterSidebarHeader canClear={hasActiveFilters} onClear={() => setParams(CLEARED_FILTERS)} />
			<FilterSidebarBody>
				<SingleCheckboxFilter
					title="Has errors"
					checked={errorsOnly}
					onChange={(checked) => setParams({ errors: checked ? "1" : null })}
					count={facetData?.errorCount}
				/>
				{/* The cheapest cut through the noise: "Engaged" alone drops bots,
				    bounces, idle tabs and glances. Every ticked tag is required. */}
				<FilterSection
					title="Session type"
					options={facetData ? tagOptions(facetData.tag) : []}
					selected={selectedTags}
					onChange={setTags}
					getOptionLabel={tagLabel}
					getOptionDescription={tagDescription}
					renderOptionIcon={tagDot}
				/>
				{/* Every page a session reached, not just where it landed — the toolbar
				    search covers the entry URL. Top 200 by sessions. */}
				<SearchableFilterSection
					title="Page visited"
					options={facetData ? withSelected(facetData.page, pagePath) : []}
					selected={pagePath ? [pagePath] : []}
					onChange={(vals) => setSingle("page", vals)}
				/>
				<SearchableFilterSection
					title="Service"
					options={facetData ? withSelected(facetData.service, service) : []}
					selected={service ? [service] : []}
					onChange={(vals) => setSingle("service", vals)}
				/>
				<SearchableFilterSection
					title="Browser"
					options={facetData ? withSelected(facetData.browser, browser) : []}
					selected={browser ? [browser] : []}
					onChange={(vals) => setSingle("browser", vals)}
				/>
				<FilterSection
					title="Device"
					options={facetData ? withSelected(facetData.device, device) : []}
					selected={device ? [device] : []}
					onChange={(vals) => setSingle("device", vals)}
				/>
				<SearchableFilterSection
					title="Country"
					options={facetData ? withSelected(facetData.country, country) : []}
					selected={country ? [country] : []}
					onChange={(vals) => setSingle("country", vals)}
					// The facet groups by the `Country` column, so the option value has
					// to stay the ISO code the query filters on; only its label is the
					// readable form.
					getOptionLabel={countryLabel}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const toolbar = (
		<Toolbar>
			<ToolbarSearch
				query={search ?? ""}
				onSearch={(value) => setParams({ q: value ?? null })}
				placeholder="Search by URL…"
				className="min-w-48 flex-1"
			/>
			{/* Same shape as the other views so it stays on one row. The error
			    count already sits on the sidebar's "Has errors" filter. */}
			<ToolbarStats className="shrink-0">
				{/* Window-wide counts from the facet query, under the same filters as
				    the list — not the rows scrolled into memory so far. */}
				{facetData?.total !== undefined ? (
					<ToolbarStat value={facetData.total} label="sessions" />
				) : (
					<ToolbarStat value={sessions.length} label={hasNextPage ? "sessions+" : "sessions"} />
				)}
				<ToolbarStat value={facetData?.live ?? 0} label="live" dot />
				<RefreshButton advance={timeWindow.advance} since={list.dataUpdatedAt} />
				<TimeRangeSelect value={range} onChange={setRange} />
			</ToolbarStats>
		</Toolbar>
	)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar} activeFilterCount={activeFilterCount}>
			{isPending ? (
				<ListSkeleton variant="card" rows={6} />
			) : isError ? (
				<ErrorState label="sessions" error={error} onRetry={() => refetch()} />
			) : sessions.length === 0 ? (
				<SignalEmptyState
					signal="sessions"
					filtered={hasActiveFilters || !!search}
					onClearFilters={() => setParams({ ...CLEARED_FILTERS, q: null })}
					range={range}
					onWidenRange={() => setRange(WIDEST_RANGE)}
				/>
			) : (
				<div className={cn("p-4", list.isPlaceholderData && "opacity-60 transition-opacity")}>
					<div className="space-y-2">
						{items.map((item) =>
							item.kind === "quiet" ? (
								<QuietRunRow
									key={`quiet:${item.key}`}
									count={item.count}
									summary={item.summary}
									tiers={item.tiers}
									expanded={item.expanded}
									onToggle={() => toggleRun(item.key)}
								/>
							) : (
								<SessionCard
									key={item.session.sessionId}
									session={item.session}
									lowSignal={item.lowSignal}
									live={isSessionLive(item.session, nowMs)}
									href={hrefFor(
										`/sessions/${encodeURIComponent(item.session.sessionId)}`,
										query,
									)}
									onFilterTag={addTag}
								/>
							),
						)}
					</div>
					{hasNextPage ? (
						<div className="flex justify-center pt-4">
							<Button
								variant="outline"
								size="sm"
								onClick={() => fetchNextPage()}
								disabled={isFetchingNextPage}
							>
								{isFetchingNextPage ? <Spinner className="size-4" /> : "Load more"}
							</Button>
						</div>
					) : null}
				</div>
			)}
		</PageShell>
	)
}

/**
 * One session. The card is a link, but its tag pills are filter buttons, and a
 * button inside an anchor is invalid HTML — so the anchor wraps only the name
 * and stretches its hit area over the whole card (the `RowLink` pattern), and
 * the pills sit above that overlay.
 */
function SessionCard({
	session,
	href,
	live,
	lowSignal,
	onFilterTag,
}: {
	session: SessionListRow
	href: string
	/** Recent heartbeat, not just `status === "active"`; see `isSessionLive`. */
	live: boolean
	/** A noise tier with no errors: drawn quieter so the sessions worth opening stand out. */
	lowSignal: boolean
	onFilterTag: (tag: SessionTag) => void
}) {
	const label = session.userId || "Anonymous"
	const initial = (label[0] ?? "?").toUpperCase()
	const DeviceIcon = isMobileDevice(session.deviceType) ? MobileIcon : ComputerIcon

	return (
		<div
			className={cn(
				"group relative flex w-full items-center gap-4 rounded-xl border border-border bg-card px-4 text-left transition-all hover:-translate-y-px hover:border-primary/40 hover:bg-accent/40 hover:shadow-sm has-[a[data-row-link]:focus-visible]:ring-2 has-[a[data-row-link]:focus-visible]:ring-ring",
				lowSignal ? "py-2 opacity-70 hover:opacity-100" : "py-3",
			)}
		>
			<div
				className={cn(
					"grid shrink-0 place-items-center rounded-full bg-gradient-to-br font-semibold text-white shadow-sm",
					gradientFor(session.sessionId),
					lowSignal ? "size-8 text-xs" : "size-10 text-sm",
				)}
			>
				{initial}
			</div>

			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2">
					<a
						href={href}
						data-row-link=""
						// The overlay covers the card, so a title on any inner element would
						// never show; the start time's absolute form rides on the link instead.
						title={`Started ${formatLocalDateTime(session.startTime)} (${formatUtcTitle(session.startTime)})`}
						className="max-w-[16rem] truncate text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-xl after:content-['']"
					>
						{label}
					</a>
					<StatusDot active={live} />
					<span className="shrink-0 font-mono text-xs text-muted-foreground">
						{session.sessionId.slice(0, 8)} · {formatSessionDuration(sessionDurationMs(session))}
					</span>
					<SessionTags tags={session.tags} onFilter={onFilterTag} />
				</div>
				<div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
					<span className="flex min-w-0 items-center gap-1.5">
						<GlobeIcon className="size-3.5 shrink-0 opacity-60" />
						<span className="max-w-[18rem] truncate">{hostFromUrl(session.urlInitial)}</span>
					</span>
					<span className="hidden items-center gap-1.5 sm:flex">
						<DeviceIcon className="size-3.5 shrink-0 opacity-60" />
						<span className="truncate">
							{session.browserName || "Unknown"}
							{session.osName ? ` · ${session.osName}` : ""}
						</span>
					</span>
					{session.country ? (
						<span className="hidden items-center gap-1.5 sm:flex" title={session.country}>
							<span aria-hidden>{flagEmoji(session.country)}</span>
							<span className="truncate">
								{countryName(session.country) ?? session.country}
							</span>
						</span>
					) : null}
				</div>
			</div>

			<div className="flex shrink-0 items-center gap-2.5 text-xs text-muted-foreground">
				<Stat icon={<PulseIcon className="size-3.5" />} value={session.clickCount} title="clicks" />
				<Stat
					icon={<EyeIcon className="size-3.5" />}
					value={session.pageViews || 1}
					title="page views"
				/>
				{session.traceCount > 0 && (
					<span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 font-medium tabular-nums text-primary">
						{session.traceCount} trace{session.traceCount === 1 ? "" : "s"}
					</span>
				)}
				{session.errorCount > 0 && (
					<span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 font-medium tabular-nums text-destructive">
						<CircleWarningIcon className="size-3" />
						{session.errorCount}
					</span>
				)}
			</div>

			<div className="flex shrink-0 items-center gap-3">
				<span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-muted-foreground">
					<ClockIcon className="size-3.5 opacity-60" />
					{formatRelativeTime(session.startTime)}
				</span>
				<span className="grid size-7 place-items-center rounded-full bg-primary/10 text-primary opacity-0 transition-opacity group-hover:opacity-100">
					<PlayGlyph />
				</span>
			</div>
		</div>
	)
}

function StatusDot({ active }: { active: boolean }) {
	if (!active) return <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
	return (
		<span className="relative flex size-1.5 shrink-0" aria-label="live">
			<span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
			<span className="relative inline-flex size-1.5 rounded-full bg-success" />
		</span>
	)
}

/** Tag pills, in display order. Each is a filter button above the card's link overlay. */
function SessionTags({
	tags,
	onFilter,
}: {
	tags: ReadonlyArray<SessionTag>
	onFilter: (tag: SessionTag) => void
}) {
	return (
		<span className="hidden min-w-0 items-center gap-1 overflow-hidden md:flex">
			{SESSION_TAG_ORDER.filter((tag) => tags.includes(tag)).map((tag) => (
				<button
					key={tag}
					type="button"
					onClick={() => onFilter(tag)}
					title={`${SESSION_TAG_DESCRIPTIONS[tag]}. Click to filter.`}
					className={cn(
						"relative inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-[10px] font-medium hover:ring-1 hover:ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
						SESSION_TAG_STYLES[tag],
					)}
				>
					{SESSION_TAG_LABELS[tag]}
				</button>
			))}
		</span>
	)
}

/** Stands in for a run of low-signal sessions; the list stays in time order. */
function QuietRunRow({
	count,
	summary,
	tiers,
	expanded,
	onToggle,
}: {
	count: number
	summary: string
	tiers: ReadonlyArray<{ readonly tag: SessionTag; readonly count: number }>
	expanded: boolean
	onToggle: () => void
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={expanded}
			className="flex w-full items-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<span className="shrink-0 whitespace-nowrap font-medium tabular-nums">
				{count} low-signal session{count === 1 ? "" : "s"}
			</span>
			<span className="flex min-w-0 items-center gap-3 overflow-hidden" title={summary}>
				{tiers.map(({ tag, count: n }) => (
					<span key={tag} className="flex shrink-0 items-center gap-1.5">
						<span className={cn("size-1.5 rounded-full", SESSION_TAG_DOTS[tag])} aria-hidden />
						<span className="tabular-nums">{n}</span> {SESSION_TAG_LABELS[tag].toLowerCase()}
						{n === 1 ? "" : "s"}
					</span>
				))}
			</span>
			<span className="ml-auto flex shrink-0 items-center gap-1">
				{expanded ? "Hide" : "Show"}
				<ChevronRightIcon
					size={14}
					aria-hidden
					className={cn("transition-transform", expanded && "rotate-90")}
				/>
			</span>
		</button>
	)
}

function Stat({ icon, value, title }: { icon: ReactNode; value: number; title: string }) {
	return (
		<span className="inline-flex items-center gap-1 tabular-nums" title={title}>
			<span className="opacity-60">{icon}</span>
			{value}
		</span>
	)
}

function PlayGlyph() {
	return (
		<svg viewBox="0 0 24 24" className="size-3.5 translate-x-px fill-current" aria-hidden>
			<path d="M8 5v14l11-7z" />
		</svg>
	)
}
