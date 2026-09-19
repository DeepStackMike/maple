// Stack-trace parsing, with no DOM and no React in it.
//
// Maple Local shows a stack in four unrelated places — the Errors view's
// expanded row (`error_events.ExceptionStacktrace`), a span's `exception.*`
// attributes, the session transcript's `session_events.ErrorStack`, and a
// browser `Error.stack` the SDK forwarded verbatim — and every one of them is
// the same opaque blob of text from an arbitrary runtime. Parsing lives here
// rather than in `stack-trace.tsx` because the interesting behaviour is all in
// the shapes: which line is a frame, which frame is the user's, and what a
// garbage input has to do (fall through untouched, not throw).
//
// Two formats are recognised. Anything else parses as `kind: "unknown"` with no
// frames, which the component renders as a `<pre>` — the fallback is a result,
// not a failure, and the raw text is always preserved so a copy button can hand
// back exactly what the runtime wrote.

/** V8/JavaScript, CPython, or a blob we could not make sense of. */
export type StackKind = "v8" | "python" | "unknown"

/**
 * A `new` or `async` prefix V8 puts in front of the function name. Kept apart
 * from `fn` so the renderer can de-emphasise it rather than making it look like
 * part of the identifier.
 */
export type FrameModifier = "async" | "new"

export interface StackFrame {
	/** Function or method name; `""` for an anonymous or bare-location frame. */
	readonly fn: string
	readonly modifier: FrameModifier | null
	/** Path, URL, or pseudo-location (`native`, `<anonymous>`); `""` when absent. */
	readonly file: string
	readonly line: number | null
	readonly column: number | null
	/** Runtime/dependency frame — collapsed behind a toggle by default. */
	readonly framework: boolean
	/** The source line, verbatim, so nothing the parser dropped is unrecoverable. */
	readonly raw: string
}

export interface StackHeader {
	/** Exception class (`TypeError`, `ValueError`, `a.b.CustomError`); `""` if unnamed. */
	readonly type: string
	readonly message: string
}

export interface ParsedStack {
	readonly kind: StackKind
	readonly header: StackHeader | null
	readonly frames: ReadonlyArray<StackFrame>
	/** The input, untouched. What the copy button copies. */
	readonly raw: string
}

/**
 * Substrings that mark a frame as somebody else's code.
 *
 * `internal/` covers Node's builtins under both spellings it prints
 * (`node:internal/...` and the bare `internal/...` of older releases);
 * `<anonymous>` as a *location* is an eval or a `<script>` block, neither of
 * which has a file to open. A `bun:` prefix is checked separately below —
 * Bun prints its builtins as a bare `bun:main`, with no slash in front.
 */
const FRAMEWORK_MARKERS = ["node_modules/", "/bun:", "internal/", "<anonymous>"] as const

/**
 * Whether a frame's *location* belongs to the runtime or a dependency.
 *
 * Deliberately the file and not the function name: `Object.<anonymous>` is how
 * V8 names the top level of an ordinary CommonJS module, and matching on the
 * name would file every entry point in a Node app under "framework".
 */
export function isFrameworkFrame(file: string): boolean {
	if (file.startsWith("bun:")) return true
	return FRAMEWORK_MARKERS.some((marker) => file.includes(marker))
}

/**
 * Above this many characters a location is shortened for display. Roughly the
 * width a path can take in the errors row or the span panel before it pushes
 * the line:col — the part you actually read — off the end.
 */
export const PATH_SHORTEN_THRESHOLD = 40

/**
 * The last two segments of a long path, e.g. a hashed bundle chunk:
 * `https://app.example.com/assets/chunks/index-a1b2c3d4.js` →
 * `chunks/index-a1b2c3d4.js`.
 *
 * Two, not one: a minified build is full of `index-*.js` and `entry-*.js`, and
 * the directory above is often the only thing distinguishing them. Callers put
 * the full string in a `title` so nothing is actually lost.
 */
export function shortenFilePath(file: string): string {
	if (file.length <= PATH_SHORTEN_THRESHOLD) return file
	const segments = file.split("/").filter((segment) => segment !== "")
	if (segments.length <= 2) return file
	return segments.slice(-2).join("/")
}

/**
 * The user's frames and the runtime's, each in source order.
 *
 * A single partition rather than per-run collapsing: a JS stack interleaves the
 * two constantly (app → framework → app → framework for any middleware or
 * promise chain), and five separate "2 framework frames" toggles down one stack
 * is noisier than the frames themselves.
 */
export function partitionFrames(frames: ReadonlyArray<StackFrame>): {
	readonly app: ReadonlyArray<StackFrame>
	readonly framework: ReadonlyArray<StackFrame>
} {
	return {
		app: frames.filter((frame) => !frame.framework),
		framework: frames.filter((frame) => frame.framework),
	}
}

// V8 / JavaScript
//
//   Error: boom
//       at handler (/app/src/index.ts:12:9)
//       at async Server.fetch (/app/src/server.ts:4:3)
//       at new Client (/app/node_modules/pg/index.js:88:1)
//       at /app/src/boot.ts:1:1
//       at <anonymous>

const V8_FRAME = /^\s*at\s+(.+)$/
const V8_CALLSITE = /^(.*?)\s+\((.*)\)$/
const V8_MODIFIER = /^(async|new)\s+(.*)$/
const LOCATION_LINE_COLUMN = /^(.*):(\d+):(\d+)$/
const LOCATION_LINE = /^(.*):(\d+)$/

/**
 * `Type: message`, where the type is a bare (possibly dotted) identifier.
 *
 * The identifier can hold no whitespace, which is what keeps an ordinary
 * sentence containing a colon — `Request failed: 502 from upstream` — from
 * being split into a type and a message that were never separate.
 */
const HEADER_LINE = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*:\s*([\s\S]*)$/

function parseLocation(location: string): { file: string; line: number | null; column: number | null } {
	const withColumn = LOCATION_LINE_COLUMN.exec(location)
	if (withColumn) {
		return { file: withColumn[1]!, line: Number(withColumn[2]), column: Number(withColumn[3]) }
	}
	const withLine = LOCATION_LINE.exec(location)
	if (withLine) return { file: withLine[1]!, line: Number(withLine[2]), column: null }
	return { file: location, line: null, column: null }
}

function parseHeaderText(text: string): StackHeader {
	const match = HEADER_LINE.exec(text)
	if (!match) return { type: "", message: text }
	return { type: match[1]!, message: match[2]! }
}

function parseV8(lines: ReadonlyArray<string>, raw: string): ParsedStack | null {
	const frames: StackFrame[] = []
	const headerLines: string[] = []
	let seenFrame = false

	for (const line of lines) {
		const frameMatch = V8_FRAME.exec(line)
		if (!frameMatch) {
			// Everything above the first frame is the message, which may itself run
			// to several lines (an assertion diff, a SQL statement). Once frames have
			// started, a non-frame line is trailing noise and is dropped.
			if (!seenFrame && line.trim() !== "") headerLines.push(line.trim())
			continue
		}
		seenFrame = true

		let rest = frameMatch[1]!.trim()
		let modifier: FrameModifier | null = null
		const modifierMatch = V8_MODIFIER.exec(rest)
		if (modifierMatch) {
			modifier = modifierMatch[1] as FrameModifier
			rest = modifierMatch[2]!
		}

		const callSite = V8_CALLSITE.exec(rest)
		const fn = callSite ? callSite[1]!.trim() : ""
		const location = callSite ? callSite[2]! : rest
		const { file, line: lineNo, column } = parseLocation(location)

		frames.push({
			fn,
			modifier,
			file,
			line: lineNo,
			column,
			framework: isFrameworkFrame(file),
			raw: line.trim(),
		})
	}

	// A header with no frames under it is just a sentence, and dressing one up as
	// a parsed stack buys nothing — the `<pre>` fallback renders it identically.
	if (frames.length === 0) return null

	return {
		kind: "v8",
		header: headerLines.length > 0 ? parseHeaderText(headerLines.join("\n")) : null,
		frames,
		raw,
	}
}

// CPython
//
//   Traceback (most recent call last):
//     File "/app/main.py", line 12, in <module>
//       do_thing()
//     File "/app/lib.py", line 5, in do_thing
//       raise ValueError("boom")
//   ValueError: boom

const PYTHON_FRAME = /^\s*File "(.*)", line (\d+)(?:, in (.+?))?\s*$/

function parsePython(lines: ReadonlyArray<string>, raw: string): ParsedStack | null {
	const frames: StackFrame[] = []
	for (const line of lines) {
		const match = PYTHON_FRAME.exec(line)
		if (!match) continue
		const file = match[1]!
		frames.push({
			fn: match[3] ?? "",
			modifier: null,
			file,
			line: Number(match[2]),
			column: null,
			framework: isFrameworkFrame(file),
			raw: line.trim(),
		})
	}
	if (frames.length === 0) return null

	// Python prints the exception last and unindented, under frames that are
	// always indented. Frames stay in source order: outermost first is how the
	// language prints them and how a Python developer reads them, and reversing
	// to match V8 would make the two agree with each other and with neither
	// runtime.
	const trailing = [...lines]
		.reverse()
		.find((line) => line.trim() !== "" && !PYTHON_FRAME.test(line) && !/^\s/.test(line))

	return {
		kind: "python",
		header: trailing ? parseHeaderText(trailing.trim()) : null,
		frames,
		raw,
	}
}

/**
 * Parse a stack of unknown provenance. Never throws; an input it does not
 * recognise comes back as `kind: "unknown"` with no frames.
 */
export function parseStackTrace(raw: string): ParsedStack {
	const unknown: ParsedStack = { kind: "unknown", header: null, frames: [], raw }
	if (raw.trim() === "") return unknown

	const lines = raw.split("\n")
	// Python first: its frame lines contain no `at `, so the two grammars cannot
	// both match, and checking it first keeps a traceback whose *message* happens
	// to contain " at " from being read as V8.
	return parsePython(lines, raw) ?? parseV8(lines, raw) ?? unknown
}
