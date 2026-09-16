import "@rrweb/replay/dist/style.css"
import { useCallback, useEffect, useRef, useState } from "react"
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
// play/pause button, a speed toggle and a scrubber.

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

interface SessionReplaySectionProps {
	sessionId: string
	/** The session's raw `ResourceAttributes` JSON, for the recorded marker. */
	resourceAttributes: string | null | undefined
	active: boolean
}

/** Loads the recording and picks the right empty/loading/player state. */
export function SessionReplaySection({ sessionId, resourceAttributes, active }: SessionReplaySectionProps) {
	const recorded = recordedMarker(resourceAttributes)
	const replay = useLocalSessionReplay(sessionId, recorded !== false)

	if (recorded === false) {
		return <p className="text-sm text-muted-foreground">Not recorded: the SDK had replay disabled or unsampled for this session.</p>
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
			events={replay.data.events}
			viewport={replay.data.viewport ?? DEFAULT_VIEWPORT}
			footer={`${replay.data.chunkCount} chunk${replay.data.chunkCount === 1 ? "" : "s"} · ${formatBytes(replay.data.byteSize)}`}
		/>
	)
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface ReplayPlayerProps {
	events: ReadonlyArray<unknown>
	viewport: ReplayViewport
	footer?: string
}

export function ReplayPlayer({ events, viewport, footer }: ReplayPlayerProps) {
	const surfaceRef = useRef<HTMLDivElement>(null)
	const mountRef = useRef<HTMLDivElement>(null)
	const replayerRef = useRef<Replayer | null>(null)
	const frameRef = useRef<number>(0)
	const [ready, setReady] = useState(false)
	const [playing, setPlaying] = useState(false)
	const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1)
	const [currentMs, setCurrentMs] = useState(0)
	const [totalMs, setTotalMs] = useState(0)

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
		const accent = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || "#6366f1"
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

	const seek = (ms: number) => {
		const replayer = replayerRef.current
		if (!replayer) return
		const clamped = Math.max(0, Math.min(ms, totalMs))
		setCurrentMs(clamped)
		if (playing) replayer.play(clamped)
		else replayer.pause(clamped)
	}

	const changeSpeed = (next: (typeof SPEEDS)[number]) => {
		setSpeed(next)
		replayerRef.current?.setConfig({ speed: next })
	}

	const aspect = viewport.width > 0 && viewport.height > 0 ? `${viewport.width} / ${viewport.height}` : "16 / 9"

	return (
		<div className="flex flex-col gap-2">
			<div
				ref={surfaceRef}
				className="relative w-full overflow-hidden rounded-lg border bg-muted/30"
				style={{ aspectRatio: aspect, maxHeight: "70vh" }}
			>
				<div ref={mountRef} className="absolute inset-0 [&_iframe]:border-0 [&_.replayer-wrapper]:absolute [&_.replayer-wrapper]:left-0 [&_.replayer-wrapper]:top-0" />
				{!ready ? (
					<div className="absolute inset-0 grid place-items-center">
						<Spinner className="size-5" />
					</div>
				) : null}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Button variant="outline" size="sm" onClick={togglePlay} disabled={!ready} aria-label={playing ? "Pause" : "Play"} className="w-20">
					{playing ? "Pause" : currentMs >= totalMs && totalMs > 0 ? "Replay" : "Play"}
				</Button>
				<span className="w-24 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
					{formatClock(currentMs)} / {formatClock(totalMs)}
				</span>
				<input
					type="range"
					min={0}
					max={Math.max(1, Math.floor(totalMs))}
					step={100}
					value={Math.floor(currentMs)}
					onChange={(event) => seek(Number(event.currentTarget.value))}
					disabled={!ready}
					aria-label="Seek"
					className="min-w-40 flex-1 accent-primary"
				/>
				<div className="flex items-center gap-1" role="group" aria-label="Playback speed">
					{SPEEDS.map((value) => (
						<button
							key={value}
							type="button"
							onClick={() => changeSpeed(value)}
							className={cn(
								"rounded-md border px-2 py-0.5 font-mono text-xs transition-colors",
								speed === value ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-accent/40",
							)}
						>
							{value}×
						</button>
					))}
				</div>
				{footer ? <span className="ml-auto text-xs text-muted-foreground">{footer}</span> : null}
			</div>
		</div>
	)
}
