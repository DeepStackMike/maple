import "@rrweb/replay/dist/style.css"
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react"
import { Replayer } from "@rrweb/replay"
import { ReplayerEvents } from "@rrweb/types"
import { Button } from "@maple/ui/components/ui/button"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { cn } from "@maple/ui/lib/utils"
import { formatClock } from "@maple/ui/lib/replay-format"
import { ErrorState } from "./view-states"
import { useLocalSessionReplay, type ReplayViewport } from "../hooks/use-local-session-replay"

// Session replay for local mode.
//
// The cloud web app plays recordings through a studio with progressive chunk
// loading, idle skipping and a marker timeline. None of that exists in
// `apps/local-ui`, so this is a deliberately small player: every chunk of the
// session is loaded in one query, concatenated, and handed to rrweb's
// `Replayer` with the same construction options the cloud engine uses
// (`apps/web/src/components/replays/engine/rrweb-engine.ts`). Transport is a
// play/pause button, a speed toggle and a scrubber with transcript markers.

const SPEEDS = [1, 2, 4, 8] as const
const DEFAULT_VIEWPORT: ReplayViewport = { width: 1280, height: 720 }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && value !== undefined && Object.getPrototypeOf(value) === Object.prototype

/** `maple.session.recorded` from the session's resource attributes; `undefined` when unknown. */
export function recordedMarker(resourceAttributes: string | null | undefined): boolean | undefined {
	if (!resourceAttributes) return undefined
	try {
		const parsed: unknown = JSON.parse(resourceAttributes)
		if (!isPlainObject(parsed)) return undefined
		const marker = parsed["maple.session.recorded"]
		return marker === "true" ? true : marker === "false" ? false : undefined
	} catch {
		return undefined
	}
}

export type ReplayMarkerKind = "click" | "error" | "navigation" | "input" | "custom"

/** A transcript event placed on the scrubber, at its offset on the playback clock. */
export interface ReplayMarker {
	readonly id: string
	readonly offsetMs: number
	readonly kind: ReplayMarkerKind
	readonly label: string
}

const MARKER_STYLES = {
	error: "bg-destructive ring-destructive/30",
	click: "bg-amber-400 ring-amber-400/30",
	navigation: "bg-emerald-400 ring-emerald-400/30",
	input: "bg-sky-400 ring-sky-400/30",
	custom: "bg-violet-400 ring-violet-400/30",
} satisfies Record<ReplayMarkerKind, string>

/** Imperative surface the session view uses to jump the player from the transcript. */
export interface ReplayPlayerHandle {
	/**
	 * Move the playhead to `offsetMs` minus `leadMs`, keeping the current
	 * play/pause state, and scroll the player into view. The offset is clamped
	 * to the recording before the lead is applied, so an event logged after the
	 * last frame still lands on the final seconds of footage.
	 */
	seek(offsetMs: number, leadMs?: number): void
}

interface SessionReplaySectionProps {
	sessionId: string
	/** The session's raw `ResourceAttributes` JSON, for the recorded marker. */
	resourceAttributes: string | null | undefined
	active: boolean
	markers?: ReadonlyArray<ReplayMarker>
}

/** Loads the recording and picks the right empty/loading/player state. */
export const SessionReplaySection = forwardRef<ReplayPlayerHandle, SessionReplaySectionProps>(
	function SessionReplaySection({ sessionId, resourceAttributes, active, markers }, ref) {
		const recorded = recordedMarker(resourceAttributes)
		const replay = useLocalSessionReplay(sessionId, recorded !== false)

		if (recorded === false) {
			return (
				<p className="text-sm text-muted-foreground">
					Not recorded: the SDK had replay disabled or unsampled for this session.
				</p>
			)
		}
		if (replay.isPending) {
			return (
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Spinner className="size-4" /> Loading recording…
				</div>
			)
		}
		if (replay.isError) return <ErrorState label="replay" error={replay.error} />
		if (replay.data.events.length < 2) {
			return (
				<p className="text-sm text-muted-foreground">
					{active
						? "No replay chunks stored yet. The SDK uploads every few seconds while the page is open."
						: "No replay chunks stored for this session."}
				</p>
			)
		}
		return (
			<ReplayPlayer
				ref={ref}
				events={replay.data.events}
				viewport={replay.data.viewport ?? DEFAULT_VIEWPORT}
				markers={markers ?? []}
				footer={`${replay.data.chunkCount} chunk${replay.data.chunkCount === 1 ? "" : "s"} · ${formatBytes(replay.data.byteSize)}`}
			/>
		)
	},
)

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface ReplayPlayerProps {
	events: ReadonlyArray<unknown>
	viewport: ReplayViewport
	markers?: ReadonlyArray<ReplayMarker>
	footer?: string
}

export const ReplayPlayer = forwardRef<ReplayPlayerHandle, ReplayPlayerProps>(function ReplayPlayer(
	{ events, viewport, markers = [], footer },
	ref,
) {
	const surfaceRef = useRef<HTMLDivElement>(null)
	const mountRef = useRef<HTMLDivElement>(null)
	const replayerRef = useRef<Replayer | null>(null)
	const frameRef = useRef<number>(0)
	const playingRef = useRef(false)
	const [ready, setReady] = useState(false)
	const [playing, setPlaying] = useState(false)
	const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1)
	const [currentMs, setCurrentMs] = useState(0)
	const [totalMs, setTotalMs] = useState(0)
	playingRef.current = playing

	// Letterbox the recorded viewport inside the surface, centred — the same
	// transform the cloud engine applies, keyed on the iframe rrweb built.
	const fit = useCallback(() => {
		const replayer = replayerRef.current
		const surface = surfaceRef.current
		if (!replayer || !surface) return
		const vw = Number(replayer.iframe?.getAttribute("width")) || viewport.width
		const vh = Number(replayer.iframe?.getAttribute("height")) || viewport.height
		const availW = surface.clientWidth
		const availH = surface.clientHeight
		if (!availW || !availH || !vw || !vh) return
		const scale = Math.min(availW / vw, availH / vh)
		const offsetX = Math.max(0, (availW - vw * scale) / 2)
		const offsetY = Math.max(0, (availH - vh * scale) / 2)
		replayer.wrapper.style.transformOrigin = "top left"
		replayer.wrapper.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`
	}, [viewport.height, viewport.width])

	// Build the replayer once per event stream.
	useEffect(() => {
		const mount = mountRef.current
		if (!mount) return
		mount.replaceChildren()
		const accent =
			getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || "#6366f1"
		const replayer = new Replayer(events as never, {
			root: mount,
			speed: 1,
			skipInactive: false,
			mouseTail: { duration: 600, lineCap: "round", lineWidth: 3, strokeStyle: accent },
			showWarning: false,
			showDebug: false,
			liveMode: false,
		})
		replayerRef.current = replayer
		replayer.on(ReplayerEvents.Finish, () => setPlaying(false))
		replayer.on(ReplayerEvents.Resize, () => fit())
		setTotalMs(replayer.getMetaData().totalTime)
		// Render the first frame without starting the clock.
		replayer.pause(0)
		setCurrentMs(0)
		setPlaying(false)
		setSpeed(1)
		setReady(true)
		fit()
		return () => {
			cancelAnimationFrame(frameRef.current)
			replayer.destroy()
			replayerRef.current = null
			setReady(false)
		}
	}, [events, fit])

	// Re-fit when the surface changes size.
	useEffect(() => {
		const surface = surfaceRef.current
		if (!surface || !globalThis.ResizeObserver) return
		const observer = new ResizeObserver(() => fit())
		observer.observe(surface)
		return () => observer.disconnect()
	}, [fit])

	// Drive the scrubber from the engine clock while playing.
	useEffect(() => {
		if (!playing) return
		const tick = () => {
			const replayer = replayerRef.current
			if (replayer) {
				const ms = replayer.getCurrentTime()
				setCurrentMs(Number.isFinite(ms) && ms > 0 ? Math.min(ms, totalMs) : 0)
			}
			frameRef.current = requestAnimationFrame(tick)
		}
		frameRef.current = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(frameRef.current)
	}, [playing, totalMs])

	const togglePlay = () => {
		const replayer = replayerRef.current
		if (!replayer) return
		if (playing) {
			replayer.pause()
			setPlaying(false)
			return
		}
		const from = currentMs >= totalMs ? 0 : currentMs
		replayer.play(from)
		setPlaying(true)
	}

	const seek = useCallback(
		(ms: number) => {
			const replayer = replayerRef.current
			if (!replayer) return
			const clamped = Math.max(0, Math.min(ms, totalMs))
			setCurrentMs(clamped)
			if (playingRef.current) replayer.play(clamped)
			else replayer.pause(clamped)
		},
		[totalMs],
	)

	useImperativeHandle(
		ref,
		() => ({
			seek(offsetMs, leadMs = 0) {
				seek(Math.min(offsetMs, totalMs) - leadMs)
				surfaceRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
			},
		}),
		[seek, totalMs],
	)

	const changeSpeed = (next: (typeof SPEEDS)[number]) => {
		setSpeed(next)
		replayerRef.current?.setConfig({ speed: next })
	}

	const aspect =
		viewport.width > 0 && viewport.height > 0 ? `${viewport.width} / ${viewport.height}` : "16 / 9"
	const visibleMarkers = totalMs > 0 ? markers.filter((m) => m.offsetMs >= 0 && m.offsetMs <= totalMs) : []

	return (
		<div className="flex flex-col gap-2">
			<div
				ref={surfaceRef}
				className="relative w-full overflow-hidden rounded-lg border bg-muted/30"
				style={{ aspectRatio: aspect, maxHeight: "70vh" }}
			>
				<div
					ref={mountRef}
					className="absolute inset-0 [&_iframe]:border-0 [&_.replayer-wrapper]:absolute [&_.replayer-wrapper]:left-0 [&_.replayer-wrapper]:top-0"
				/>
				{!ready ? (
					<div className="absolute inset-0 grid place-items-center">
						<Spinner className="size-5" />
					</div>
				) : null}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					onClick={togglePlay}
					disabled={!ready}
					aria-label={playing ? "Pause" : "Play"}
					className="w-20"
				>
					{playing ? "Pause" : currentMs >= totalMs && totalMs > 0 ? "Replay" : "Play"}
				</Button>
				<span className="w-24 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
					{formatClock(currentMs)} / {formatClock(totalMs)}
				</span>
				<div className="relative min-w-40 flex-1">
					{/* Transcript markers sit above the scrubber; each is a button that seeks. */}
					<div
						className="pointer-events-none absolute inset-x-0 -top-2 h-2"
						aria-hidden={visibleMarkers.length === 0}
					>
						{visibleMarkers.map((marker) => (
							<button
								key={marker.id}
								type="button"
								onClick={() => seek(marker.offsetMs)}
								title={`${formatClock(marker.offsetMs)} · ${marker.label}`}
								aria-label={`Jump to ${marker.kind} at ${formatClock(marker.offsetMs)}`}
								data-marker-kind={marker.kind}
								className={cn(
									"pointer-events-auto absolute top-0 size-2 -translate-x-1/2 rounded-full ring-2 transition-transform hover:scale-150",
									MARKER_STYLES[marker.kind],
								)}
								style={{ left: `${(marker.offsetMs / totalMs) * 100}%` }}
							/>
						))}
					</div>
					<input
						type="range"
						min={0}
						max={Math.max(1, Math.floor(totalMs))}
						step={100}
						value={Math.floor(currentMs)}
						onChange={(event) => seek(Number(event.currentTarget.value))}
						disabled={!ready}
						aria-label="Seek"
						className="w-full accent-primary"
					/>
				</div>
				<fieldset className="flex items-center gap-1 border-0 p-0" aria-label="Playback speed">
					{SPEEDS.map((value) => (
						<button
							key={value}
							type="button"
							onClick={() => changeSpeed(value)}
							className={cn(
								"rounded-md border px-2 py-0.5 font-mono text-xs transition-colors",
								speed === value
									? "border-primary bg-primary/10 text-foreground"
									: "text-muted-foreground hover:bg-accent/40",
							)}
						>
							{value}×
						</button>
					))}
				</fieldset>
				{footer ? <span className="ml-auto text-xs text-muted-foreground">{footer}</span> : null}
			</div>
		</div>
	)
})
