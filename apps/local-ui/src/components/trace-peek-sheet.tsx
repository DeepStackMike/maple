// The peek: a trace's page, in a sheet, without leaving the list. Ported from
// the hosted app (#896) onto Local's own trace pieces — the shared waterfall
// (log badges and span panel included) and a local anatomy strip.
//
// Triage is a walk down a list, and a full navigation per row costs the scroll
// and the filters each time. The sheet shows what the trace page would, ↑/↓
// walk the list behind it, and "Open trace" (or Enter) is there when a row
// earns the whole page. The same row still opens the page on a modified,
// middle or right click, so both are one click away without a setting.

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { ArrowDownIcon } from "@maple/ui/components/icons"
import { HttpSpanLabel } from "@maple/ui/components/traces/http-span-label"
import { Button } from "@maple/ui/components/ui/button"
import { Kbd } from "@maple/ui/components/ui/kbd"
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@maple/ui/components/ui/sheet"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"
import { useLocalTraceDetail } from "../hooks/use-local-trace-detail"
import { stepFor } from "../lib/trace-peek"
import type { SpanPanelTab } from "./span-detail-panel"
import { TraceAnatomyStrip } from "./trace-anatomy-strip"
import { TraceWaterfall } from "./trace-waterfall"
import { ErrorState } from "./view-states"

function isTextEntry(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.isContentEditable
	)
}

/**
 * A control the user chose to focus keeps its own Enter — a Tab-reachable
 * button, link or tab. Waterfall rows take focus on click without being a
 * choice to press *that* thing with Enter, so Enter still opens the page.
 */
function keepsEnter(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	const control = target.closest("a, button, [role='tab'], [role='menuitem'], [role='option']")
	return control instanceof HTMLElement && control.tabIndex >= 0
}

export interface TracePeekSheetProps {
	traceId: string | null
	/** Where the trace sits in the loaded list, for "3 of 50" and the arrows. `null` when not loaded. */
	position: { index: number; count: number } | null
	onStep: (delta: 1 | -1) => void
	onClose: () => void
	/** The full trace page, for "Open trace" and Enter. */
	openHref: string
	/** The sheet's body — `TracePeekBody` for the peeked trace. */
	children: ReactNode
}

export function TracePeekSheet({
	traceId,
	position,
	onStep,
	onClose,
	openHref,
	children,
}: TracePeekSheetProps) {
	const popupRef = useRef<HTMLDivElement>(null)
	const openPageRef = useRef<HTMLAnchorElement>(null)
	const open = traceId !== null

	/**
	 * Keys inside the popup are handled in the CAPTURE phase, so the waterfall's
	 * own arrow handling cannot swallow a step. Presses from outside it (focus
	 * left on the page) go through the document listener below, which yields
	 * whenever the press came from inside — a key is handled exactly once.
	 */
	const handleKey = (event: KeyboardEvent | ReactKeyboardEvent): boolean => {
		if (event.metaKey || event.ctrlKey || event.altKey) return false
		if (isTextEntry(event.target)) return false
		if (event.key === "Enter") {
			if (keepsEnter(event.target)) return false
			openPageRef.current?.click()
			return true
		}
		const delta = stepFor(event.key)
		if (delta === undefined) return false
		onStep(delta)
		return true
	}

	const handleKeyDownCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
		if (handleKey(event)) {
			event.preventDefault()
			event.stopPropagation()
		}
	}

	const handleKeyRef = useRef(handleKey)
	handleKeyRef.current = handleKey
	useEffect(() => {
		if (!open) return
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.target instanceof Node && popupRef.current?.contains(event.target)) return
			if (handleKeyRef.current(event)) event.preventDefault()
		}
		document.addEventListener("keydown", onKeyDown)
		return () => document.removeEventListener("keydown", onKeyDown)
	}, [open])

	const canStepBack = position !== null && position.index > 0
	const canStepForward = position !== null && position.index < position.count - 1

	return (
		<Sheet open={open} onOpenChange={(next) => !next && onClose()}>
			{/* Focus lands on the popup itself, not its first control: Enter and the
			    arrows then mean the sheet's shortcuts until the user Tabs to a control. */}
			<SheetContent
				ref={popupRef}
				initialFocus={popupRef}
				className="w-[min(1100px,calc(100vw-2rem))] p-0 outline-none sm:max-w-[min(1100px,calc(100vw-2rem))]"
				onKeyDownCapture={handleKeyDownCapture}
			>
				{traceId !== null ? (
					<>
						{children}
						<SheetFooter className="flex-row items-center justify-between gap-3 border-t">
							<div className="flex items-center gap-1.5">
								<Button
									variant="outline"
									size="icon-sm"
									aria-label="Previous trace"
									title="Previous trace (↑ or K)"
									disabled={!canStepBack}
									onClick={() => onStep(-1)}
								>
									<ArrowDownIcon size={14} className="rotate-180" />
								</Button>
								<Button
									variant="outline"
									size="icon-sm"
									aria-label="Next trace"
									title="Next trace (↓ or J)"
									disabled={!canStepForward}
									onClick={() => onStep(1)}
								>
									<ArrowDownIcon size={14} />
								</Button>
								{position ? (
									<span className="ml-1 font-mono text-[11px] text-muted-foreground tabular-nums">
										{position.index + 1} of {position.count}
									</span>
								) : null}
							</div>
							<Button size="sm" render={<a ref={openPageRef} href={openHref} />}>
								Open trace
								<Kbd className="ml-1 hidden bg-black/15 text-current sm:inline-flex">↵</Kbd>
							</Button>
						</SheetFooter>
					</>
				) : null}
			</SheetContent>
		</Sheet>
	)
}

/** The peeked trace: summary strip, waterfall and span panel. */
export function TracePeekBody({
	traceId,
	selectedSpanId,
	onSelectSpan,
}: {
	traceId: string
	selectedSpanId: string | undefined
	onSelectSpan: (spanId: string | undefined) => void
}) {
	// A step keeps the previous trace on screen, dimmed, until the next arrives.
	const trace = useLocalTraceDetail(traceId, { keepPrevious: true })
	// The panel's tab is the sheet's own: it outlives a step, so a reader going
	// through the list log-first stays on the logs.
	const [panelTab, setPanelTab] = useState<SpanPanelTab>("details")

	if (trace.isPending) {
		return (
			<>
				<PeekHeader title={<span className="font-mono">{traceId.slice(0, 8)}</span>}>
					<SheetDescription className="sr-only">Loading trace details</SheetDescription>
				</PeekHeader>
				<div className="flex-1 space-y-3 overflow-hidden p-4">
					<Skeleton className="h-1.5 w-full rounded-full" />
					<div className="rounded-md border">
						{Array.from({ length: 6 }).map((_, i) => (
							<div key={i} className="flex items-center gap-2 border-b p-3 last:border-0">
								<Skeleton className="size-4" />
								<Skeleton className="h-4 w-20" />
								<Skeleton className="h-4 flex-1" />
								<Skeleton className="h-2 w-32" />
							</div>
						))}
					</div>
				</div>
			</>
		)
	}

	if (trace.isError) {
		return (
			<>
				<PeekHeader title={<span className="font-mono">{traceId.slice(0, 8)}</span>}>
					<SheetDescription className="sr-only">Failed to load trace</SheetDescription>
				</PeekHeader>
				<div className="flex-1 overflow-auto p-4">
					<ErrorState label="trace" error={trace.error} onRetry={() => trace.refetch()} />
				</div>
			</>
		)
	}

	const data = trace.data
	// Everything rendered, the id included, comes from the loaded data, so the
	// dimmed view during a step is one coherent trace, never the next id over
	// the previous spans.
	const shownTraceId = data.spans[0]?.traceId ?? traceId
	const rootSpan = data.rootSpans[0]

	if (!rootSpan) {
		return (
			<PeekHeader title={<span className="font-mono">{shownTraceId.slice(0, 8)}</span>}>
				<SheetDescription>
					No spans found for this trace. It may be outside the store's retention, or its spans have
					not arrived yet.
				</SheetDescription>
			</PeekHeader>
		)
	}

	return (
		<div
			className={cn(
				"flex min-h-0 flex-1 flex-col transition-opacity",
				trace.isPlaceholderData && "opacity-50",
			)}
		>
			<PeekHeader
				title={
					<HttpSpanLabel
						spanName={rootSpan.spanName}
						spanAttributes={rootSpan.spanAttributes}
						spanKind={rootSpan.spanKind}
						className="gap-3"
					/>
				}
			>
				<SheetDescription className="sr-only">
					Spans and timing for trace {shownTraceId}
				</SheetDescription>
			</PeekHeader>
			<div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
				<TraceAnatomyStrip traceId={shownTraceId} data={data} />
				<div className="min-h-0 flex-1 overflow-hidden rounded-md border">
					<TraceWaterfall
						traceId={shownTraceId}
						data={data}
						selectedSpanId={selectedSpanId}
						onSelectSpan={onSelectSpan}
						panelTab={panelTab}
						onPanelTabChange={(tab, spanId) => {
							setPanelTab(tab)
							if (spanId) onSelectSpan(spanId)
						}}
					/>
				</div>
			</div>
		</div>
	)
}

function PeekHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
	return (
		<SheetHeader className="gap-1.5 pr-14">
			<span className="text-[10px] font-medium tracking-[0.1em] text-muted-foreground uppercase">
				Trace
			</span>
			<SheetTitle className="min-w-0 text-[15px] leading-tight">{title}</SheetTitle>
			{children}
		</SheetHeader>
	)
}
