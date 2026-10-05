// The one way Maple Local draws a payload.
//
// A span carries `db.query.text`, a `gen_ai.input.messages` array, an HTTP
// request body, a SOAP envelope, an OAuth form post — and every one of them
// used to land in an attributes value cell or a bare `<pre>`, as one
// undifferentiated wall of monospace. This is the block all of them get
// instead: detected, formatted, coloured, foldable, and copyable back out
// exactly as the service sent it.
//
// Two renderers behind one component. JSON goes through `sugar-high`, which is
// already a dependency, weighs about a kilobyte and knows that grammar; SQL,
// XML and URL-encoded forms go through the scanners in `lib/code-block.ts`.
// Both emit `sh__line` spans separated by real newlines, so one CSS rule
// numbers the gutter for either and neither needs the other to exist.
//
// The palette is `--code-*` in `styles.css`, which Sugar High's own `--sh-*`
// names alias onto. Local-ui shipped `highlightJson` without ever defining
// `--sh-*`, so every token resolved to an unset custom property and inherited
// the body colour: the highlighting was in the DOM and invisible on screen.
// That is the bug the operator was looking at.

import { useMemo, useState } from "react"
import { ChevronDownIcon } from "@maple/ui/components/icons"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { cn } from "@maple/ui/lib/utils"
import { highlightJson } from "../lib/highlight"
import {
	CODE_RENDER_LIMIT,
	prepareCode,
	toLines,
	tokenizeCode,
	type CodeLanguage,
	type CodeTokenType,
} from "../lib/code-block"

/**
 * Lines shown before the block folds.
 *
 * Tall enough that a small payload is simply *there* — a four-key object, a
 * one-line statement — and short enough that a 600-line `gen_ai` transcript
 * does not push the rest of the panel off the bottom of the scroll area.
 */
export const CODE_BLOCK_COLLAPSE_AFTER = 14

/**
 * Tailwind utilities over the `--code-*` palette. Spelled out per token rather
 * than interpolated — Tailwind only emits classes that appear literally in the
 * source — and `plain` is deliberately empty so ordinary text inherits the
 * block's own colour instead of being assigned one.
 */
const TOKEN_CLASS: Record<CodeTokenType, string> = {
	attr: "text-code-attr",
	comment: "text-code-comment",
	key: "text-code-key",
	keyword: "text-code-keyword",
	number: "text-code-number",
	placeholder: "text-code-placeholder",
	plain: "",
	punctuation: "text-code-punctuation",
	string: "text-code-string",
	tag: "text-code-tag",
} satisfies Record<CodeTokenType, string>

const LANGUAGE_LABEL: Record<CodeLanguage, string> = {
	form: "form",
	json: "json",
	sql: "sql",
	text: "text",
	xml: "xml",
} satisfies Record<CodeLanguage, string>

export interface CodeBlockProps {
	/** The value as the service sent it. Never pre-format it — that is this component's job. */
	value: string
	/** Skip detection. Pass this only where the caller genuinely knows better. */
	language?: CodeLanguage
	/** Chip text; defaults to the detected language. An attribute key reads better here. */
	label?: string
	/** Gutter line numbers. Worth it for a whole-record payload, noise on a two-line one. */
	lineNumbers?: boolean
	/** Lines tolerated before the block folds. */
	collapseAfter?: number
	/** Names the value in the copy button's label and toast. */
	copyLabel?: string
	/** Tighter type scale, for a block inside another list's row. */
	compact?: boolean
	className?: string
}

/** A header control — the raw/pretty toggle and the fold. */
function CodeAction({
	onClick,
	label,
	className,
	children,
}: {
	onClick: () => void
	label: string
	className?: string
	children: React.ReactNode
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={(event) => {
				// These blocks sit inside rows and panels that have their own click
				// handlers; folding a payload is not selecting the thing around it.
				event.preventDefault()
				event.stopPropagation()
				onClick()
			}}
			className={cn(
				"inline-flex cursor-pointer items-center gap-1 rounded text-[10px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				className,
			)}
		>
			{children}
		</button>
	)
}

/**
 * A structured value, painted.
 *
 * Detection, formatting and tokenizing are all in `lib/code-block.ts`; this
 * file owns only what it looks like and which parts of it you can fold away.
 */
export function CodeBlock({
	value,
	language,
	label,
	lineNumbers,
	collapseAfter = CODE_BLOCK_COLLAPSE_AFTER,
	copyLabel,
	compact,
	className,
}: CodeBlockProps) {
	// Pretty by default: an API that minifies its JSON is the common case, and
	// the reason you opened the panel is to read it.
	const [pretty, setPretty] = useState(true)
	const [expanded, setExpanded] = useState(false)

	const prepared = useMemo(() => prepareCode(value, { pretty, language }), [value, pretty, language])

	const foldable = prepared.lineCount > collapseAfter
	const clamped = foldable && !expanded
	// The clamp cuts the *text*, not the height: highlighting 600 lines to show
	// 14 of them is work thrown away, and a CSS clamp over a `dangerouslySetInnerHTML`
	// block cannot be undone by the copy button anyway.
	const visible = useMemo(
		() => (clamped ? prepared.text.split("\n").slice(0, collapseAfter).join("\n") : prepared.text),
		[clamped, collapseAfter, prepared.text],
	)

	const html = useMemo(
		() => (prepared.language === "json" ? highlightJson(visible) : null),
		[prepared.language, visible],
	)
	const lines = useMemo(
		() => (prepared.language === "json" ? null : toLines(tokenizeCode(visible, prepared.language))),
		[prepared.language, visible],
	)

	const chip = label ?? LANGUAGE_LABEL[prepared.language]

	if (value === "") return null

	return (
		<div
			className={cn(
				"code-block overflow-hidden rounded-md border bg-muted/30",
				lineNumbers && "code-block--numbered",
				className,
			)}
		>
			<div className="flex items-center gap-2 border-b border-border/40 px-2 py-1">
				<span
					className="min-w-0 truncate font-mono text-[10px] tracking-wide text-muted-foreground"
					title={chip}
				>
					{chip}
				</span>

				{prepared.truncated ? (
					<span
						className="shrink-0 rounded border border-border/60 px-1 text-[9px] uppercase text-muted-foreground"
						title={`Showing the first ${CODE_RENDER_LIMIT.toLocaleString()} characters. Copy still yields the whole value.`}
					>
						truncated
					</span>
				) : null}

				<div className="ml-auto flex shrink-0 items-center gap-1">
					{/* Only offered when the two renditions actually differ — a payload
					    that arrived pretty-printed has nothing to toggle to. */}
					{prepared.canPretty ? (
						<CodeAction
							label={pretty ? "Show the raw value" : "Pretty-print"}
							className="px-1 py-0.5"
							onClick={() => setPretty((prev) => !prev)}
						>
							{pretty ? "Raw" : "Pretty"}
						</CodeAction>
					) : null}
					<CopyButton
						// Always the original: what you paste into a psql prompt or a bug
						// report has to be what the service actually sent, not the
						// formatted or clamped rendition of it.
						value={prepared.copyText}
						label={copyLabel ?? chip}
						toast={false}
						iconSize={11}
						className="h-5 w-5"
					/>
				</div>
			</div>

			<pre
				className={cn(
					"max-h-96 overflow-auto whitespace-pre-wrap break-words px-2 py-1.5 font-mono leading-relaxed",
					compact ? "text-[10px]" : "text-[11px]",
				)}
			>
				{html !== null ? (
					<code dangerouslySetInnerHTML={{ __html: html }} />
				) : (
					<code>
						{(lines ?? []).map((line, index) => (
							// Lines are positional and the whole list is rebuilt whenever the
							// text changes, so the index is the identity.
							<span key={index}>
								{index > 0 ? "\n" : null}
								{/* Sugar High's own class, reused, so one gutter rule numbers
								    both renderers. Inline, like its output — the newline above
								    is what breaks the line inside a `pre`. */}
								<span className="sh__line">
									{line.map((token, tokenIndex) => (
										<span key={tokenIndex} className={TOKEN_CLASS[token.type]}>
											{token.text}
										</span>
									))}
								</span>
							</span>
						))}
					</code>
				)}
			</pre>

			{foldable ? (
				<div className="border-t border-border/40 px-2 py-1">
					<CodeAction
						label={expanded ? "Show fewer lines" : "Show all lines"}
						onClick={() => setExpanded((prev) => !prev)}
					>
						<ChevronDownIcon
							size={10}
							className={cn("transition-transform", expanded && "rotate-180")}
						/>
						{expanded ? "Show less" : `Show all ${prepared.lineCount.toLocaleString()} lines`}
					</CodeAction>
				</div>
			) : null}
		</div>
	)
}
