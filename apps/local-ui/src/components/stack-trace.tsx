// The one way Maple Local draws a stack.
//
// Four surfaces show one — the Errors view's expanded row, a span's
// `exception.*` attributes, the session transcript, and whatever a browser
// `Error.stack` carried — and before this they showed three different things:
// a truncated one-line `sampleMessage`, an attributes-table row with the whole
// stack crammed into a value cell, and a `<pre>`. The parsing is in
// `lib/stack-trace.ts`; this file is only the shape it takes on screen.
//
// Two ideas do the work. The frame is split in two — the function you are
// looking for, then its location underneath and dimmed, with the line:col
// brought back up, because "which line" is the part you retype into an editor.
// And the runtime's frames fold away: a Bun/Node stack is mostly `node_modules`
// and `node:internal`, and a stack that opens on ten of those reads as noise no
// matter how well each line is set.

import { useState } from "react"
import { ChevronRightIcon } from "@maple/ui/components/icons"
import { CopyIndicator } from "@maple/ui/components/ui/copy-button"
import { useCopy } from "@maple/ui/hooks/use-copy"
import { cn } from "@maple/ui/lib/utils"
import {
	parseStackTrace,
	partitionFrames,
	shortenFilePath,
	type StackFrame,
	type StackHeader,
} from "../lib/stack-trace"

export interface StackTraceProps {
	/** Raw stack text — `ExceptionStacktrace`, `exception.stacktrace`, `ErrorStack`. */
	stack: string
	/**
	 * Header fallback for stacks that carry none. The warehouse stores the class
	 * and the message in their own columns (`ExceptionType`/`ExceptionMessage`),
	 * and the stacktrace it stores beside them often starts straight at the first
	 * frame.
	 */
	exceptionType?: string
	exceptionMessage?: string
	/** Off where the surrounding row already states the message — the transcript. */
	showHeader?: boolean
	/** Tighter type scale, for a stack sitting inside another list's row. */
	compact?: boolean
	/** Fold the whole frame list behind a "Show stack" toggle past `collapseAfter`. */
	collapsible?: boolean
	/** Frames tolerated before `collapsible` folds. */
	collapseAfter?: number
	/**
	 * Render the toggles as `role="button"` spans instead of `<button>`s.
	 *
	 * The session transcript's rows are themselves buttons (they seek the replay
	 * player), and a button inside a button is invalid HTML that React warns
	 * about. The affordances still take focus and still fire on Enter/Space.
	 */
	nested?: boolean
	className?: string
}

/**
 * A toggle, or the copy control, that adapts its element to where it sits. See
 * `nested` above for why the tag is not always a `<button>`.
 */
function StackAction({
	nested,
	onClick,
	label,
	title,
	className,
	children,
}: {
	nested?: boolean
	onClick: () => void
	label: string
	title?: string
	className?: string
	children: React.ReactNode
}) {
	const Tag = nested ? "span" : "button"
	return (
		<Tag
			{...(nested
				? {
						role: "button" as const,
						tabIndex: 0,
						onKeyDown: (event: React.KeyboardEvent) => {
							if (event.key !== "Enter" && event.key !== " ") return
							event.preventDefault()
							event.stopPropagation()
							onClick()
						},
					}
				: { type: "button" as const })}
			aria-label={label}
			title={title ?? label}
			// Stopped in every case: the transcript row this can sit inside seeks the
			// replay player on click, and expanding a stack is not a seek.
			onClick={(event: React.MouseEvent) => {
				event.preventDefault()
				event.stopPropagation()
				onClick()
			}}
			className={cn(
				"inline-flex cursor-pointer items-center gap-1 rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				className,
			)}
		>
			{children}
		</Tag>
	)
}

function StackCopy({ value, nested }: { value: string; nested?: boolean }) {
	// `toast: false` — these live on list rows and in a side panel; one toast per
	// click would stack up behind the thing you just copied.
	const { copy, status } = useCopy({ label: "stack trace", toast: false })
	return (
		<StackAction
			nested={nested}
			label="Copy stack trace"
			title="Copy stack trace"
			className="shrink-0 p-0.5"
			onClick={() => void copy(value)}
		>
			<CopyIndicator status={status} size={12} />
		</StackAction>
	)
}

function FrameRow({ frame, compact }: { frame: StackFrame; compact?: boolean }) {
	const shortFile = shortenFilePath(frame.file)
	const position =
		frame.line === null ? "" : frame.column === null ? `:${frame.line}` : `:${frame.line}:${frame.column}`

	return (
		<li className={cn("px-2", compact ? "py-0.5" : "py-1")}>
			<p className={cn("truncate font-mono", compact ? "text-[10px]" : "text-[11px]")}>
				{frame.modifier ? <span className="text-muted-foreground">{frame.modifier} </span> : null}
				<span className={frame.fn ? "text-foreground" : "italic text-muted-foreground"}>
					{frame.fn || "anonymous"}
				</span>
			</p>
			{frame.file ? (
				<p
					// The full location stays reachable: `shortenFilePath` throws away the
					// leading segments of a long bundle URL, and the one thing you might
					// want off a minified frame is exactly which chunk it was.
					title={`${frame.file}${position}`}
					className="truncate font-mono text-[10px] text-muted-foreground"
				>
					{shortFile}
					{position ? <span className="text-foreground/70">{position}</span> : null}
				</p>
			) : null}
		</li>
	)
}

function FrameList({
	frames,
	compact,
	nested,
}: {
	frames: ReadonlyArray<StackFrame>
	compact?: boolean
	nested?: boolean
}) {
	const { app, framework } = partitionFrames(frames)
	const [showFramework, setShowFramework] = useState(false)

	// A stack that is *entirely* somebody else's code — a crash inside a driver,
	// a bundled browser build where every frame is a chunk — has no in-app frames
	// to fall back on, so folding them all away would leave an empty list under a
	// toggle. There, the runtime frames are the answer.
	const allFramework = app.length === 0

	return (
		// Bounded: a deep async stack runs to sixty frames, and in the span panel
		// that would push the attributes tables off the bottom of the scroll area.
		<div className={cn("overflow-auto", compact ? "max-h-40" : "max-h-72")}>
			<ol className="divide-y divide-border/40">
				{(allFramework ? frames : app).map((frame, index) => (
					<FrameRow key={`${frame.raw}-${index}`} frame={frame} compact={compact} />
				))}
			</ol>
			{!allFramework && framework.length > 0 ? (
				<div className="border-t border-border/40">
					<StackAction
						nested={nested}
						label={showFramework ? "Hide framework frames" : "Show framework frames"}
						className="w-full px-2 py-1 text-[10px]"
						onClick={() => setShowFramework((prev) => !prev)}
					>
						<ChevronRightIcon
							size={10}
							className={cn("transition-transform", showFramework && "rotate-90")}
						/>
						{framework.length === 1
							? "1 framework frame"
							: `${framework.length} framework frames`}
					</StackAction>
					{showFramework ? (
						<ol className="divide-y divide-border/40 border-t border-border/40 bg-muted/30">
							{framework.map((frame, index) => (
								<FrameRow key={`${frame.raw}-${index}`} frame={frame} compact={compact} />
							))}
						</ol>
					) : null}
				</div>
			) : null}
		</div>
	)
}

function Header({ header, compact }: { header: StackHeader; compact?: boolean }) {
	return (
		<div className={cn("min-w-0 flex-1", compact ? "text-[11px]" : "text-xs")}>
			{header.type ? (
				<span className="font-mono font-semibold text-destructive">{header.type}</span>
			) : null}
			{header.type && header.message ? <span className="text-muted-foreground">: </span> : null}
			{header.message ? (
				<span className="break-words font-medium text-foreground">{header.message}</span>
			) : null}
		</div>
	)
}

/**
 * Render a stack trace. Parses V8 and Python; anything else falls through to a
 * monospace `<pre>` of the original text, which is a result and not an error —
 * an unrecognised runtime should still show you its stack.
 */
export function StackTrace({
	stack,
	exceptionType,
	exceptionMessage,
	showHeader = true,
	compact,
	collapsible,
	collapseAfter = 3,
	nested,
	className,
}: StackTraceProps) {
	const parsed = parseStackTrace(stack)
	const header =
		parsed.header ??
		(exceptionType || exceptionMessage
			? { type: exceptionType ?? "", message: exceptionMessage ?? "" }
			: null)

	// What the copy button hands back is what the runtime wrote — never the
	// parse. When there is no stack at all, the header is the only thing there is
	// to copy.
	const copyValue =
		stack.trim() !== ""
			? stack
			: header
				? `${header.type}${header.type ? ": " : ""}${header.message}`
				: ""

	// An unparsed blob has no frames to count, so its lines stand in: three of
	// either is the same "is this worth folding away" question.
	const bodyUnits = parsed.frames.length > 0 ? parsed.frames.length : stack.trim().split("\n").length
	const bodyNoun = parsed.frames.length > 0 ? "frames" : "lines"
	const foldable = collapsible === true && stack.trim() !== "" && bodyUnits > collapseAfter
	const [open, setOpen] = useState(false)
	const bodyVisible = !foldable || open

	const body =
		stack.trim() === "" ? null : parsed.frames.length > 0 ? (
			<FrameList frames={parsed.frames} compact={compact} nested={nested} />
		) : (
			<pre
				className={cn(
					"max-h-72 overflow-auto whitespace-pre-wrap break-all px-2 py-1 font-mono text-muted-foreground",
					compact ? "text-[10px]" : "text-[11px]",
				)}
			>
				{parsed.raw}
			</pre>
		)

	if (!header && !body) return null

	// The copy control rides whichever bar is on top, so there is exactly one of
	// it and it is never the only thing in a row of its own.
	const headerBar = showHeader ? header : null
	const controlBar = headerBar === null && body !== null

	return (
		<div className={cn("overflow-hidden rounded-md border bg-muted/30", className)}>
			{headerBar ? (
				<div
					className={cn(
						"flex items-start gap-2 px-2",
						compact ? "py-1" : "py-1.5",
						body && "border-b",
					)}
				>
					<Header header={headerBar} compact={compact} />
					<StackCopy value={copyValue} nested={nested} />
				</div>
			) : null}

			{foldable || controlBar ? (
				<div className="flex items-center justify-between gap-2 px-2 py-1">
					{foldable ? (
						<StackAction
							nested={nested}
							label={open ? "Hide stack" : "Show stack"}
							className="text-[10px]"
							onClick={() => setOpen((prev) => !prev)}
						>
							<ChevronRightIcon
								size={10}
								className={cn("transition-transform", open && "rotate-90")}
							/>
							{open ? "Hide stack" : `Show stack (${bodyUnits} ${bodyNoun})`}
						</StackAction>
					) : (
						<span className="text-[10px] text-muted-foreground">
							{bodyUnits} {bodyNoun}
						</span>
					)}
					{controlBar ? <StackCopy value={copyValue} nested={nested} /> : null}
				</div>
			) : null}

			{bodyVisible ? (
				<div className={foldable || controlBar ? "border-t border-border/40" : ""}>{body}</div>
			) : null}
		</div>
	)
}
