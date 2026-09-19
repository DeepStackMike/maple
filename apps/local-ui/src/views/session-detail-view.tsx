// Session Replay — the local-mode counterpart of the hosted replay page.
//
// The shape is the hosted one: an identity row and a stats strip, a metadata
// line, then the recording on the left inside a browser frame with a tabbed
// console/network/errors panel beside it. Everything in the panel is keyed to
// the playback clock in both directions — a row seeks the player, and the
// player highlights the row it is currently inside — which is the whole point
// of putting them side by side rather than one under the other.
//
// The arithmetic (active/idle, which row the playhead is in, which page the
// address bar shows) is in `lib/session-detail.ts` and tested there.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Button } from "@maple/ui/components/ui/button"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { CopyableBadge } from "@maple/ui/components/ui/copyable-badge"
import { Tabs, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import {
	ArrowLeftIcon,
	ArrowRightIcon,
	CircleWarningIcon,
	CodeIcon,
	ComputerIcon,
	GlobeIcon,
	MobileIcon,
	NetworkNodesIcon,
	PulseIcon,
	SparkleIcon,
} from "@maple/ui/components/icons"
import { cn } from "@maple/ui/lib/utils"
import { formatDuration } from "@maple/ui/lib/format"
import type { SessionReplayDetailOutput, SessionTranscriptOutput } from "@maple/query-engine/ch"
import {
	useLocalSessionDetail,
	useLocalSessionTraces,
	useLocalSessionTranscript,
} from "../hooks/use-local-session-detail"
import { parseAttributes } from "@maple/ui/lib/span-tree"
import { formatLocation, type FormattedLocation } from "../lib/geo"
import { formatRelativeTime } from "../lib/time"
import { formatSessionDuration, gradientFor, hostFromUrl, isMobileDevice } from "@maple/ui/lib/replay-format"
import { ErrorState } from "../components/view-states"
import { RefreshButton } from "../components/toolbar"
import {
	MarkerDot,
	recordedMarker,
	SessionReplaySection,
	type ActiveMarker,
	type ReplayMarker,
	type ReplayMarkerKind,
	type ReplayPlayerHandle,
} from "../components/session-replay-player"
import { useLocalSessionReplay } from "../hooks/use-local-session-replay"
import { StackTrace } from "../components/stack-trace"
import { useLocation } from "../lib/router"
import {
	computeActivity,
	currentIndexAt,
	customProperties,
	eventsForTab,
	isErrorEvent,
	offsetLabel,
	parseChTime,
	SESSION_EVENT_TAB_LABELS,
	SESSION_EVENT_TABS,
	tabCounts,
	urlAt,
	type SessionEventTab,
} from "../lib/session-detail"

interface SessionDetailViewProps {
	sessionId: string
	onBack: () => void
	onSelectTrace: (traceId: string) => void
}

/** How far before an error the player lands, so the lead-up is visible. */
const ERROR_LEAD_MS = 3000

export function SessionDetailView({ sessionId, onBack, onSelectTrace }: SessionDetailViewProps) {
	const { data: session, isPending, isError, error } = useLocalSessionDetail(sessionId)
	const traceIds = session?.traceIds ?? []
	const traces = useLocalSessionTraces(traceIds)
	const transcript = useLocalSessionTranscript(sessionId)
	const events = useMemo(() => transcript.data ?? [], [transcript.data])

	const isActive = session?.status === "active"
	const hasError = (session?.errorCount ?? 0) > 0

	// Transcript → player. The recording's clock starts at its first rrweb event,
	// so a transcript row seeks to (row time − first event time). Errors land a
	// few seconds early so the lead-up is visible. Same query key as the player,
	// so this is a cache read, not a second fetch.
	const playerRef = useRef<ReplayPlayerHandle>(null)
	// Hovering a scrubber marker highlights its transcript row and vice versa.
	const [activeMarker, setActiveMarker] = useState<ActiveMarker | null>(null)
	// The playhead, pushed up by the player so the address bar and the panel's
	// highlighted row can follow it.
	const [playheadMs, setPlayheadMs] = useState(0)
	const [playerReady, setPlayerReady] = useState(false)
	const replay = useLocalSessionReplay(sessionId, recordedMarker(session?.resourceAttributes) !== false)
	const baseMs = replay.data?.baseTimestampMs
	const offsetFor = (event: SessionTranscriptOutput): number | undefined => {
		if (baseMs === undefined) return undefined
		const at = parseChTime(event.timestamp)
		return Number.isNaN(at) ? undefined : Math.max(0, at - baseMs)
	}
	const markers = useMemo<ReplayMarker[]>(() => {
		if (baseMs === undefined) return []
		return events.flatMap((event) => {
			const kind = markerKind(event)
			if (!kind) return []
			const at = parseChTime(event.timestamp)
			if (Number.isNaN(at)) return []
			return [
				{
					id: transcriptRowId(event),
					offsetMs: Math.max(0, at - baseMs),
					kind,
					label: markerLabel(event),
				},
			]
		})
	}, [events, baseMs])
	const jumpTo = (event: SessionTranscriptOutput) => {
		const offset = offsetFor(event)
		if (offset === undefined) return
		playerRef.current?.seek(offset, isErrorEvent(event) ? ERROR_LEAD_MS : 0)
	}

	// `#/sessions/<id>?jump=<seq>` — a deep link from anywhere that knows a
	// single distilled event (an error list, an agent's answer). Applied once the
	// recording is ready, because seeking a player that has no replayer yet is a
	// no-op that looks like the link silently not working.
	const { query } = useLocation()
	const jumpSeq = query.get("jump")
	const jumpedRef = useRef<string | null>(null)
	useEffect(() => {
		if (jumpSeq === null || !playerReady || baseMs === undefined) return
		if (jumpedRef.current === jumpSeq) return
		const target = events.find((event) => String(event.seq) === jumpSeq)
		if (!target) return
		jumpedRef.current = jumpSeq
		const at = parseChTime(target.timestamp)
		if (Number.isNaN(at)) return
		playerRef.current?.seek(Math.max(0, at - baseMs), isErrorEvent(target) ? ERROR_LEAD_MS : 0)
		// Light the row up too: the link named an event, not a timestamp.
		setActiveMarker({ id: transcriptRowId(target), source: "scrubber" })
	}, [jumpSeq, playerReady, baseMs, events])

	const activity = useMemo(() => computeActivity(events), [events])
	const navigations = useMemo(() => {
		if (baseMs === undefined) return []
		return events.flatMap((event) => {
			if (event.type !== "navigation") return []
			const at = parseChTime(event.timestamp)
			if (Number.isNaN(at)) return []
			return [{ offsetMs: Math.max(0, at - baseMs), url: event.url }]
		})
	}, [events, baseMs])
	const chromeUrl = urlAt(navigations, playheadMs, session?.urlInitial ?? "")

	const identity = session ? displayName(session, sessionId) : sessionId
	const DeviceIcon = session && isMobileDevice(session.deviceType) ? MobileIcon : ComputerIcon
	const location = useMemo(() => (session ? sessionLocation(session) : undefined), [session])
	const locationLabel = location ? [location.flag, location.label].filter(Boolean).join(" ") : ""

	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
					<ArrowLeftIcon size={14} />
					Sessions
				</Button>
				<span className="truncate font-mono text-xs text-muted-foreground" title={sessionId}>
					{sessionId}
				</span>
				<RefreshButton className="ml-auto" />
			</div>

			<div className="min-h-0 flex-1 overflow-auto">
				{isPending ? (
					<div className="flex h-full items-center justify-center">
						<Spinner />
					</div>
				) : isError ? (
					<ErrorState label="session" error={error} />
				) : !session ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						Session not found.
					</div>
				) : (
					<div className="mx-auto max-w-[100rem] px-4 py-5">
						<h1 className="text-sm font-medium text-muted-foreground">Session Replay</h1>

						{/* Identity + stats */}
						<div className="mt-2 flex flex-wrap items-start justify-between gap-x-8 gap-y-4 border-b pb-5">
							<div className="flex min-w-0 flex-1 items-center gap-4">
								<div
									className={`grid size-12 shrink-0 place-items-center rounded-full bg-gradient-to-br ${gradientFor(sessionId)} text-base font-semibold text-white shadow-sm`}
								>
									{(identity[0] ?? "?").toUpperCase()}
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<h2 className="truncate text-xl font-semibold tracking-tight">
											{identity}
										</h2>
										<StatusBadge active={isActive} />
									</div>
									<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
										<span
											className="max-w-80 truncate"
											title={session.urlInitial || undefined}
										>
											{hostFromUrl(session.urlInitial) || "—"}
										</span>
										<span>{formatRelativeTime(session.startTime)}</span>
										<CopyableBadge
											value={sessionId}
											label="session ID"
											className="font-mono text-[11px]"
										>
											{sessionId.slice(0, 8)}
										</CopyableBadge>
									</div>
								</div>
							</div>

							<dl className="grid grid-cols-3 gap-x-6 gap-y-3 sm:grid-cols-6">
								<Stat
									label="Duration"
									value={isActive ? "Live" : formatSessionDuration(session.durationMs)}
								/>
								<Stat label="Active" value={statDuration(activity.activeMs)} />
								<Stat label="Idle" value={statDuration(activity.idleMs)} />
								<Stat label="Clicks" value={String(session.clickCount)} />
								<Stat label="Pages" value={String(session.pageViews)} />
								<Stat label="Errors" value={String(session.errorCount)} danger={hasError} />
							</dl>
						</div>

						{/* Metadata */}
						<dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-b py-4 sm:grid-cols-4">
							<Meta
								label="Browser"
								value={[session.browserName, session.osName].filter(Boolean).join(" · ")}
								icon={<DeviceIcon className="size-3.5 opacity-60" />}
							/>
							<Meta label="Device" value={session.deviceType} />
							<Meta label="Location" value={locationLabel} title={location?.title} />
							<Meta label="Service" value={session.serviceName} />
						</dl>

						{/* Player + event panel */}
						<div className="mt-5 grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
							<div className="flex min-w-0 flex-col gap-5">
								<SessionReplaySection
									ref={playerRef}
									sessionId={sessionId}
									resourceAttributes={session.resourceAttributes}
									active={isActive}
									markers={markers}
									activeMarker={activeMarker}
									onActiveMarkerChange={setActiveMarker}
									chromeUrl={chromeUrl}
									onTimeChange={setPlayheadMs}
									onReady={() => setPlayerReady(true)}
								/>

								<UserCard session={session} />

								<Card title={`Correlated traces · ${traceIds.length}`}>
									{traceIds.length === 0 ? (
										<p className="text-sm text-muted-foreground">
											No backend traces correlated.
										</p>
									) : traces.isPending ? (
										<Spinner className="size-4" />
									) : (
										<ul className="space-y-1.5">
											{(traces.data ?? []).map((trace) => (
												<li key={trace.traceId}>
													<button
														type="button"
														onClick={() => onSelectTrace(trace.traceId)}
														className="group flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
													>
														<span
															className={cn(
																"size-1.5 shrink-0 rounded-full",
																trace.hasError
																	? "bg-destructive"
																	: "bg-muted-foreground/40",
															)}
														/>
														<span className="min-w-0 flex-1">
															<span className="block truncate text-sm">
																{trace.rootSpanName ||
																	trace.traceId.slice(0, 12)}
															</span>
															<span className="block truncate text-xs text-muted-foreground">
																{trace.rootServiceName || "unknown"} ·{" "}
																{trace.spanCount} spans
															</span>
														</span>
														<span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
															{formatDuration(trace.durationMs)}
														</span>
														<ArrowRightIcon
															size={14}
															className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
														/>
													</button>
												</li>
											))}
										</ul>
									)}
								</Card>
							</div>

							<EventPanel
								events={events}
								startTime={session.startTime}
								isPending={transcript.isPending}
								isError={transcript.isError}
								error={transcript.error}
								onJump={baseMs === undefined ? undefined : jumpTo}
								baseMs={baseMs}
								playheadMs={playheadMs}
								activeMarker={activeMarker}
								onActiveMarkerChange={setActiveMarker}
							/>
						</div>
					</div>
				)}
			</div>
		</div>
	)
}

// The event panel

interface EventPanelProps {
	events: ReadonlyArray<SessionTranscriptOutput>
	startTime: string
	isPending: boolean
	isError: boolean
	error: unknown
	/** Present once the recording is loaded; rows then seek the player. */
	onJump?: (event: SessionTranscriptOutput) => void
	/** rrweb's zero on the playback clock; `undefined` until the recording loads. */
	baseMs: number | undefined
	playheadMs: number
	activeMarker: ActiveMarker | null
	onActiveMarkerChange: (active: ActiveMarker | null) => void
}

function EventPanel({
	events,
	startTime,
	isPending,
	isError,
	error,
	onJump,
	baseMs,
	playheadMs,
	activeMarker,
	onActiveMarkerChange,
}: EventPanelProps) {
	const [tab, setTab] = useState<SessionEventTab>("all")
	const counts = useMemo(() => tabCounts(events), [events])
	const rows = useMemo(() => eventsForTab(events, tab), [events, tab])

	// Which row the playhead is inside. Offsets are derived here rather than
	// stored on the rows: the transcript can arrive before the recording does,
	// and until it does every offset is `NaN` and nothing is highlighted.
	const offsets = useMemo(
		() =>
			rows.map((event) =>
				baseMs === undefined ? Number.NaN : Math.max(0, parseChTime(event.timestamp) - baseMs),
			),
		[rows, baseMs],
	)
	const currentIndex = currentIndexAt(offsets, playheadMs)

	// Following the playhead must not fight the pointer: a list that scrolls
	// itself out from under a hovering cursor is unclickable.
	const listRef = useRef<HTMLOListElement>(null)
	const [hovering, setHovering] = useState(false)
	useEffect(() => {
		if (hovering || currentIndex < 0 || !listRef.current) return
		listRef.current
			.querySelector<HTMLElement>(`[data-row-index="${currentIndex}"]`)
			?.scrollIntoView({ block: "nearest" })
	}, [currentIndex, hovering, tab])

	// A marker hovered on the scrubber brings its row into view; a hovered row never scrolls itself.
	useEffect(() => {
		if (activeMarker?.source !== "scrubber" || !listRef.current) return
		listRef.current
			.querySelector<HTMLElement>(`[data-transcript-id="${CSS.escape(activeMarker.id)}"]`)
			?.scrollIntoView({ block: "nearest", behavior: "smooth" })
	}, [activeMarker])

	return (
		<section className="flex min-w-0 flex-col rounded-xl border bg-card">
			<Tabs
				className="gap-0 border-b px-2 pt-1.5"
				value={tab}
				onValueChange={(next) => setTab(next as SessionEventTab)}
			>
				<TabsList variant="underline" className="w-full justify-start gap-0.5">
					{SESSION_EVENT_TABS.map((key) => (
						<TabsTrigger key={key} value={key} className="h-8 grow-0 px-2 text-xs">
							{SESSION_EVENT_TAB_LABELS[key]}
							<span className="ml-1 tabular-nums text-muted-foreground">({counts[key]})</span>
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>

			{isPending ? (
				<div className="p-4">
					<Spinner className="size-4" />
				</div>
			) : isError ? (
				<div className="p-4">
					<ErrorState label="transcript" error={error} />
				</div>
			) : rows.length === 0 ? (
				<p className="p-4 text-sm text-muted-foreground">
					{events.length === 0
						? "No distilled events for this session."
						: `No ${SESSION_EVENT_TAB_LABELS[tab].toLowerCase()} events in this session.`}
				</p>
			) : (
				<ol
					ref={listRef}
					onMouseEnter={() => setHovering(true)}
					onMouseLeave={() => setHovering(false)}
					className="max-h-[36rem] min-h-0 divide-y overflow-auto lg:max-h-[calc(100vh-14rem)]"
				>
					{rows.map((event, index) => {
						const id = transcriptRowId(event)
						return (
							<EventRow
								key={id}
								event={event}
								index={index}
								startTime={startTime}
								onJump={onJump}
								current={index === currentIndex}
								hovered={activeMarker?.id === id}
								onActiveMarkerChange={onActiveMarkerChange}
							/>
						)
					})}
				</ol>
			)}
		</section>
	)
}

function EventRow({
	event,
	index,
	startTime,
	onJump,
	current,
	hovered,
	onActiveMarkerChange,
}: {
	event: SessionTranscriptOutput
	index: number
	startTime: string
	onJump?: (event: SessionTranscriptOutput) => void
	/** The playhead is inside this row. */
	current: boolean
	/** A scrubber marker or this row itself is under the pointer. */
	hovered: boolean
	onActiveMarkerChange: (active: ActiveMarker | null) => void
}) {
	const danger = isErrorEvent(event)
	const id = transcriptRowId(event)
	const kind = markerKind(event)
	const Row = onJump ? "button" : "div"
	const hover = kind
		? {
				onMouseEnter: () => onActiveMarkerChange({ id, source: "transcript" as const }),
				onMouseLeave: () => onActiveMarkerChange(null),
			}
		: {}

	return (
		<li data-transcript-id={id} data-row-index={index}>
			<Row
				{...hover}
				{...(onJump
					? {
							type: "button" as const,
							onClick: () => onJump(event),
							title: danger
								? "Jump to 3 s before this event in the replay"
								: "Jump to this event in the replay",
							"aria-label": `Jump to ${event.type} at ${offsetLabel(startTime, event.timestamp)}`,
						}
					: {})}
				aria-current={current ? "true" : undefined}
				className={cn(
					"flex w-full gap-2.5 px-3 py-2 text-left transition-colors",
					onJump && "hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none",
					current && "bg-primary/5 shadow-[inset_2px_0_0_0_var(--primary)]",
					hovered && "bg-accent/60",
				)}
			>
				<span className="w-12 shrink-0 pt-0.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
					{offsetLabel(startTime, event.timestamp)}
				</span>
				<span
					className={cn(
						"mt-0.5 grid size-5 shrink-0 place-items-center rounded-full",
						danger ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
					)}
				>
					<EventIcon event={event} />
				</span>
				<div className="min-w-0 flex-1">
					<EventBody event={event} />
				</div>
				{kind ? <MarkerDot kind={kind} className="mt-1.5 size-1.5" /> : null}
			</Row>
		</li>
	)
}

function EventBody({ event }: { event: SessionTranscriptOutput }) {
	switch (event.type) {
		case "navigation":
			return (
				<p className="truncate text-xs text-muted-foreground" title={event.url}>
					<span className="mr-1.5 font-medium text-foreground">Navigate</span>
					{event.url || "—"}
				</p>
			)
		case "click":
			return (
				<p className="truncate text-xs text-muted-foreground">
					<span className="mr-1.5 font-medium text-foreground">Click</span>
					{event.targetText || event.targetSelector || "element"}
				</p>
			)
		case "input":
			return (
				<p className="truncate font-mono text-xs text-muted-foreground">
					{event.targetSelector || "input"}
				</p>
			)
		case "console":
			return (
				<p className="break-words text-xs text-muted-foreground">
					<span
						className={cn(
							"mr-1.5 font-medium uppercase",
							event.level === "error"
								? "text-destructive"
								: event.level === "warn"
									? "text-amber-500"
									: "text-foreground",
						)}
					>
						{event.level || "log"}
					</span>
					{event.message}
				</p>
			)
		case "network":
			return (
				<p className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
					<span className="shrink-0 font-medium text-foreground">{event.netMethod}</span>
					<span
						className={cn(
							"shrink-0 font-mono tabular-nums",
							event.netStatus === 0
								? "text-destructive"
								: event.netStatus >= 400
									? "text-destructive"
									: "text-success",
						)}
					>
						{event.netStatus || "ERR"}
					</span>
					<span className="min-w-0 flex-1 truncate" title={event.netUrl}>
						{event.netUrl}
					</span>
					<span className="shrink-0 tabular-nums">{Math.round(event.netDurationMs)}ms</span>
				</p>
			)
		case "error":
			return (
				<div>
					<p className="break-words text-xs text-destructive">{event.message}</p>
					{event.errorStack ? (
						// `showHeader` off: the message is already the line above, and a
						// browser `Error.stack` repeats it as its own first line. `nested`
						// because the row itself is a button that seeks the player, so the
						// toggles cannot be buttons — and a click on one is not a seek.
						<StackTrace
							className="mt-1"
							stack={event.errorStack}
							showHeader={false}
							compact
							collapsible
							nested
						/>
					) : null}
				</div>
			)
		case "custom":
			return <CustomEventBody event={event} />
		default:
			return <p className="truncate text-xs text-muted-foreground">{event.message}</p>
	}
}

/** `MapleBrowser.track(name, props)` — the name is `Message`, the props are `Attributes`. */
function CustomEventBody({ event }: { event: SessionTranscriptOutput }) {
	const properties = customProperties(event)
	return (
		<div className="min-w-0">
			<p className="truncate text-xs font-medium">{event.message || "custom event"}</p>
			{properties.length > 0 ? (
				<dl className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
					{properties.map(([key, value]) => (
						<div key={key} className="flex min-w-0 gap-1 font-mono text-[11px]">
							<dt className="shrink-0 text-muted-foreground">{key}</dt>
							<dd className="truncate" title={value}>
								{value}
							</dd>
						</div>
					))}
				</dl>
			) : null}
		</div>
	)
}

// The user card

function UserCard({ session }: { session: SessionReplayDetailOutput }) {
	const traits = useMemo(() => Object.entries(parseAttributes(session.userTraits)), [session.userTraits])
	const group = session.groupName || session.groupId
	return (
		<Card title="User">
			<dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
				<Field label="User ID" value={session.userId} />
				<Field label="Name" value={session.userName} />
				<Field label="Email" value={session.userEmail} />
				<Field
					label="Group"
					value={group}
					title={session.groupId && session.groupName ? session.groupId : undefined}
				/>
			</dl>
			{traits.length === 0 ? (
				<p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
					No traits. The browser SDK writes these from `identify(userId, traits)`.
				</p>
			) : (
				<dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-3 sm:grid-cols-4">
					{traits.map(([key, value]) => (
						<div key={key} className="min-w-0">
							<dt className="truncate font-mono text-[11px] text-muted-foreground" title={key}>
								{key}
							</dt>
							<dd className="truncate text-sm" title={value}>
								{value || "—"}
							</dd>
						</div>
					))}
				</dl>
			)}
		</Card>
	)
}

// Bits

function markerKind(event: SessionTranscriptOutput): ReplayMarkerKind | undefined {
	if (isErrorEvent(event)) return "error"
	switch (event.type) {
		case "click":
			return "click"
		case "navigation":
			return "navigation"
		case "input":
			return "input"
		case "custom":
			return "custom"
		default:
			return undefined
	}
}

function markerLabel(event: SessionTranscriptOutput): string {
	switch (event.type) {
		case "navigation":
			return `Navigate ${event.url}`
		case "click":
			return `Click ${event.targetText || event.targetSelector || "element"}`
		case "input":
			return `Input ${event.targetSelector || ""}`.trim()
		case "network":
			return `${event.netMethod} ${event.netUrl} → ${event.netStatus}`
		default:
			return `${event.type} ${event.message}`.trim()
	}
}

const transcriptRowId = (event: SessionTranscriptOutput) => `${event.seq}-${event.timestamp}`

function EventIcon({ event }: { event: SessionTranscriptOutput }) {
	const className = "size-3"
	switch (event.type) {
		case "navigation":
			return <GlobeIcon className={className} />
		case "click":
		case "input":
			return <PulseIcon className={className} />
		case "console":
			return <CodeIcon className={className} />
		case "network":
			return <NetworkNodesIcon className={className} />
		case "error":
			return <CircleWarningIcon className={className} />
		case "custom":
			return <SparkleIcon className={className} />
		default:
			return <CodeIcon className={className} />
	}
}

/**
 * The stats strip's duration cells. `formatSessionDuration` renders zero as
 * "—" because an unmeasured session is not an instantaneous one; here zero idle
 * is a measurement, so it keeps its own cell and only `null` reads as unknown.
 */
function statDuration(ms: number | null): string {
	if (ms === null) return "—"
	return ms === 0 ? "0s" : formatSessionDuration(ms)
}

/** The name at the top of the page: whoever `identify()` named, else the session id. */
function displayName(session: SessionReplayDetailOutput, sessionId: string): string {
	return session.userName || session.userEmail || session.userId || sessionId
}

function StatusBadge({ active }: { active: boolean }) {
	if (active) {
		return (
			<span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
				<span className="relative flex size-1.5">
					<span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
					<span className="relative inline-flex size-1.5 rounded-full bg-success" />
				</span>
				Active
			</span>
		)
	}
	return (
		<span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
			Ended
		</span>
	)
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
	return (
		<div className="min-w-0">
			<dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
			<dd
				className={cn(
					"mt-0.5 text-lg font-semibold tabular-nums tracking-tight",
					danger && "text-destructive",
				)}
			>
				{value}
			</dd>
		</div>
	)
}

function Meta({
	label,
	value,
	title,
	icon,
}: {
	label: string
	value: string
	title?: string
	icon?: ReactNode
}) {
	return (
		<div className="min-w-0">
			<dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
			<dd className="mt-0.5 flex items-center gap-1.5 truncate text-sm" title={title ?? value}>
				{icon}
				<span className="truncate">{value || "—"}</span>
			</dd>
		</div>
	)
}

/**
 * Where the visitor was, over two sources: `Country` is a `session_replays`
 * column the gateway resolves from an edge header, and the region and city only
 * exist as `geo.*` keys the ingest sidecar writes into `ResourceAttributes`.
 * The column wins when both name a country — it is the one every other surface
 * (the list card, the Countries breakdown, the facet) groups by, so a detail
 * page disagreeing with it would be the bug.
 */
function sessionLocation(session: SessionReplayDetailOutput): FormattedLocation | undefined {
	const attributes = parseAttributes(session.resourceAttributes)
	return formatLocation({
		country: session.country || attributes["geo.country.iso_code"],
		regionCode: attributes["geo.region.iso_code"],
		regionName: attributes["geo.region.name"],
		city: attributes["geo.locality.name"],
	})
}

function Card({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="rounded-xl border bg-card p-4">
			<h2 className="mb-3 text-sm font-medium">{title}</h2>
			{children}
		</section>
	)
}

function Field({
	label,
	value,
	title,
	className,
}: {
	label: string
	value: string
	title?: string
	className?: string
}) {
	return (
		<div className={cn("min-w-0", className)}>
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="truncate" title={title ?? value}>
				{value || "—"}
			</dd>
		</div>
	)
}
