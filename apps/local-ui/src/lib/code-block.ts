// Language detection, formatting and tokenizing for the payloads Maple Local
// shows as code — with no DOM and no React in it.
//
// A trace carries text that is *structured* and text that is *prose*, and until
// now the UI drew both the same way: `db.query.text` in an attributes value
// cell, a `gen_ai.input.messages` array as one unbroken 4,000-character line, an
// XML SOAP body as a `<pre>`. Detection is a guess about a string with no
// content-type attached to it, so it lives here — pure and testable — and the
// component only paints what this decides.
//
// The tokenizers are deliberately small and hand-rolled rather than a grammar.
// `sugar-high` (already a dependency, ~1 kB) covers the JS/JSON-shaped half of
// what arrives; SQL, XML and URL-encoded forms are each a single-pass scanner
// below, together smaller than any one parser would be. None of them validate:
// a truncated payload still has to colour, because a truncated payload is
// exactly the one you are squinting at.

/** What a value turned out to be. `text` is the honest answer, not a failure. */
export type CodeLanguage = "json" | "sql" | "xml" | "form" | "text"

/**
 * The token vocabulary shared by every tokenizer here and by the stack-trace
 * frames, so one `--code-*` palette paints all of them. Sugar High's own token
 * names are aliased onto the same palette in `styles.css`.
 */
export type CodeTokenType =
	| "plain"
	| "key"
	| "string"
	| "number"
	| "keyword"
	| "punctuation"
	| "comment"
	| "tag"
	| "attr"
	| "placeholder"

export interface CodeToken {
	readonly text: string
	readonly type: CodeTokenType
}

/**
 * Above this many characters a value is never handed to `JSON.parse`.
 *
 * Detection runs on every attribute of every span the panel opens, and parsing
 * a megabyte of JSON to decide how to colour it costs more than the colouring
 * is worth. Over the limit the delimiter sniff still calls it JSON — it will
 * render raw rather than pretty, which is the right trade for a payload that
 * large anyway.
 */
export const CODE_PARSE_LIMIT = 200_000

/**
 * Characters actually handed to the renderer. Past this the block shows a
 * prefix and says so; the copy button still yields the whole value, so nothing
 * is unrecoverable.
 */
export const CODE_RENDER_LIMIT = 50_000

/**
 * Length at which an *unremarkable* attribute value earns a code block on shape
 * alone. Below it a JSON-ish scalar (`{"a":1}`) reads better as a table row than
 * as a bordered block with its own toolbar.
 */
export const CODE_BLOCK_MIN_LENGTH = 120

// Detection

/** Cheap delimiter gate, so a plain sentence never reaches `JSON.parse`. */
function looksLikeJson(trimmed: string): boolean {
	const first = trimmed[0]
	const last = trimmed[trimmed.length - 1]
	return (first === "{" && last === "}") || (first === "[" && last === "]")
}

/**
 * Leading SQL comments, stripped before the opening keyword is read.
 *
 * ORMs and query builders prepend them constantly — a sqlcommenter block, or a
 * `-- name: GetUser` marker — and a statement whose first token is a comment is
 * still a statement.
 */
function stripLeadingSqlComments(text: string): string {
	let rest = text.trimStart()
	for (;;) {
		if (rest.startsWith("--")) {
			const newline = rest.indexOf("\n")
			if (newline === -1) return ""
			rest = rest.slice(newline + 1).trimStart()
			continue
		}
		if (rest.startsWith("/*")) {
			const end = rest.indexOf("*/")
			if (end === -1) return ""
			rest = rest.slice(end + 2).trimStart()
			continue
		}
		return rest
	}
}

const SQL_OPENER =
	/^(select|insert|update|delete|with|create|alter|drop|truncate|merge|replace|explain|analyze|vacuum|upsert)\b/i

/**
 * A second keyword, required before an opener is believed.
 *
 * "Select a plan" and "Update failed" are ordinary English sentences that open
 * with a SQL verb, and an error message rendered as SQL is worse than one
 * rendered as prose. Every real statement in one of those verbs carries one of
 * these too.
 */
const SQL_BODY = /\b(from|into|set|values|table|where|join|returning|using|group\s+by|order\s+by)\b/i

/** Standalone transaction-control statements, which have no body to match. */
const SQL_TRANSACTION = /^(begin|commit|rollback|start\s+transaction|savepoint\b.*)[\s;]*$/i

function looksLikeSql(trimmed: string): boolean {
	const body = stripLeadingSqlComments(trimmed)
	if (body === "") return false
	if (SQL_TRANSACTION.test(body)) return true
	return SQL_OPENER.test(body) && SQL_BODY.test(body)
}

/** `a=1&b=hello%20world`, `q=x+y` — one line, `key=value` throughout. */
const FORM_PAIRS = /^[\w.[\]~-]+(?:%[0-9A-Fa-f]{2}[\w.[\]~-]*)*=[^&\s]*(?:&[\w.[\]~%-]+=[^&\s]*)*$/

function looksLikeForm(trimmed: string): boolean {
	if (trimmed.includes("\n")) return false
	if (!trimmed.includes("=")) return false
	// A lone `a=b` is as likely to be a label as a form body. Something that
	// *encodes* — a separator or a percent escape — is what makes it a payload.
	if (!trimmed.includes("&") && !/%[0-9A-Fa-f]{2}/.test(trimmed) && !trimmed.includes("+")) return false
	return FORM_PAIRS.test(trimmed)
}

/**
 * What a string is, by shape alone. Never throws, and always answers — `text`
 * is the fallback for everything it cannot place.
 *
 * Order matters: JSON and XML are decided by their delimiters (which no other
 * candidate here can open with), then SQL by its opening verb, then the form
 * encoding, which is the loosest grammar of the four and so goes last.
 */
export function detectLanguage(value: string): CodeLanguage {
	const trimmed = value.trim()
	if (trimmed === "") return "text"

	if (looksLikeJson(trimmed)) return "json"
	// A `<` opener with a closing bracket somewhere: enough to be markup, and it
	// rules out a bare `<= 3` or a `<redacted>` placeholder standing alone.
	if (trimmed.startsWith("<") && trimmed.includes(">")) return "xml"
	if (looksLikeSql(trimmed)) return "sql"
	if (looksLikeForm(trimmed)) return "form"
	return "text"
}

// Formatting

/**
 * Pretty-printed JSON, or `null` when the value will not parse — a truncated or
 * NDJSON payload still colours, it just has no second rendition to offer.
 */
export function formatJson(value: string): string | null {
	if (value.length > CODE_PARSE_LIMIT) return null
	try {
		return JSON.stringify(JSON.parse(value) as unknown, null, 2)
	} catch {
		return null
	}
}

/** `a=1&b=hello%20world` as one decoded `key = value` per line. */
export function formatForm(value: string): string | null {
	const trimmed = value.trim()
	if (trimmed === "") return null
	const decode = (part: string) => {
		try {
			return decodeURIComponent(part.replace(/\+/g, " "))
		} catch {
			// A stray `%` is not an error worth surfacing — show the bytes as sent.
			return part
		}
	}
	return trimmed
		.split("&")
		.map((pair) => {
			const eq = pair.indexOf("=")
			if (eq === -1) return decode(pair)
			return `${decode(pair.slice(0, eq))} = ${decode(pair.slice(eq + 1))}`
		})
		.join("\n")
}

export interface PreparedCode {
	readonly language: CodeLanguage
	/** The text to paint — pretty-printed when asked for and available. */
	readonly text: string
	/** The original value, whole. What the copy button hands back, always. */
	readonly copyText: string
	readonly lineCount: number
	/** `text` is a prefix: the value was over `CODE_RENDER_LIMIT`. */
	readonly truncated: boolean
	/** A pretty rendition exists and differs from the raw one — drives the toggle. */
	readonly canPretty: boolean
}

/**
 * Everything the renderer needs about a value, in one pass.
 *
 * The copy text is the input verbatim and never the formatted or truncated
 * version: what you paste into a psql prompt or a bug report has to be what the
 * service actually sent.
 */
export function prepareCode(
	value: string,
	options: { readonly pretty?: boolean; readonly language?: CodeLanguage } = {},
): PreparedCode {
	const language = options.language ?? detectLanguage(value)
	const formatted = language === "json" ? formatJson(value) : language === "form" ? formatForm(value) : null
	const canPretty = formatted !== null && formatted !== value
	const chosen = canPretty && options.pretty !== false ? formatted : value

	const truncated = chosen.length > CODE_RENDER_LIMIT
	const text = truncated ? chosen.slice(0, CODE_RENDER_LIMIT) : chosen

	return {
		language,
		text,
		copyText: value,
		lineCount: text === "" ? 0 : text.split("\n").length,
		truncated,
		canPretty,
	}
}

// Tokenizing

interface MutableToken {
	text: string
	type: CodeTokenType
}

/**
 * Appends to a token list, merging into the previous token when the type
 * matches. A 2,000-line SQL statement is mostly whitespace and identifiers, and
 * one `<span>` per character is a real cost on a panel that opens on every
 * click.
 */
function pusher(tokens: Array<MutableToken>) {
	return (text: string, type: CodeTokenType) => {
		if (text === "") return
		const last = tokens[tokens.length - 1]
		if (last !== undefined && last.type === type) last.text += text
		else tokens.push({ text, type })
	}
}

const SQL_KEYWORDS = new Set([
	"add",
	"all",
	"alter",
	"analyze",
	"and",
	"any",
	"array",
	"as",
	"asc",
	"attach",
	"begin",
	"between",
	"by",
	"case",
	"cast",
	"check",
	"collate",
	"column",
	"commit",
	"constraint",
	"create",
	"cross",
	"current",
	"database",
	"default",
	"delete",
	"desc",
	"describe",
	"detach",
	"distinct",
	"drop",
	"else",
	"end",
	"escape",
	"except",
	"exists",
	"explain",
	"extract",
	"false",
	"fetch",
	"filter",
	"final",
	"first",
	"for",
	"foreign",
	"format",
	"from",
	"full",
	"global",
	"group",
	"having",
	"if",
	"ilike",
	"in",
	"index",
	"inner",
	"insert",
	"intersect",
	"interval",
	"into",
	"is",
	"join",
	"key",
	"last",
	"lateral",
	"left",
	"like",
	"limit",
	"materialized",
	"merge",
	"natural",
	"not",
	"null",
	"nulls",
	"offset",
	"on",
	"only",
	"optimize",
	"or",
	"order",
	"outer",
	"over",
	"partition",
	"prewhere",
	"primary",
	"qualify",
	"recursive",
	"references",
	"rename",
	"replace",
	"returning",
	"right",
	"rollback",
	"sample",
	"select",
	"set",
	"settings",
	"show",
	"some",
	"table",
	"then",
	"to",
	"true",
	"truncate",
	"union",
	"unique",
	"update",
	"using",
	"values",
	"view",
	"when",
	"where",
	"window",
	"with",
])

function isIdentifierStart(ch: string): boolean {
	return /[A-Za-z_]/.test(ch)
}

function isIdentifierPart(ch: string): boolean {
	return /[A-Za-z0-9_$]/.test(ch)
}

/**
 * A single-pass SQL scanner.
 *
 * Placeholders are their own token type on purpose: `$1`, `?`, `:name`,
 * `@name` and ClickHouse's `{name:Type}` are the parts of a logged statement
 * that are *not* the statement, and telling them apart from the literals around
 * them is most of what reading `db.query.text` is for.
 */
export function tokenizeSql(source: string): Array<CodeToken> {
	const tokens: Array<MutableToken> = []
	const push = pusher(tokens)
	let i = 0

	while (i < source.length) {
		const ch = source[i]!

		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			const start = i
			while (i < source.length && /\s/.test(source[i]!)) i += 1
			push(source.slice(start, i), "plain")
			continue
		}

		// `-- comment` and MySQL's `# comment`, both to end of line.
		if ((ch === "-" && source[i + 1] === "-") || ch === "#") {
			const newline = source.indexOf("\n", i)
			const end = newline === -1 ? source.length : newline
			push(source.slice(i, end), "comment")
			i = end
			continue
		}

		if (ch === "/" && source[i + 1] === "*") {
			const close = source.indexOf("*/", i + 2)
			const end = close === -1 ? source.length : close + 2
			push(source.slice(i, end), "comment")
			i = end
			continue
		}

		// A single-quoted literal, with SQL's doubled-quote escape and the
		// backslash escape most engines also accept.
		if (ch === "'") {
			let j = i + 1
			while (j < source.length) {
				if (source[j] === "\\") {
					j += 2
					continue
				}
				if (source[j] === "'") {
					if (source[j + 1] === "'") {
						j += 2
						continue
					}
					j += 1
					break
				}
				j += 1
			}
			push(source.slice(i, Math.min(j, source.length)), "string")
			i = Math.min(j, source.length)
			continue
		}

		// A quoted identifier — a column, not a value, so it reads as a key.
		if (ch === '"' || ch === "`") {
			const close = source.indexOf(ch, i + 1)
			const end = close === -1 ? source.length : close + 1
			push(source.slice(i, end), "key")
			i = end
			continue
		}

		// `$1`, `$42` — Postgres' numbered parameters.
		if (ch === "$" && /[0-9]/.test(source[i + 1] ?? "")) {
			let j = i + 1
			while (j < source.length && /[0-9]/.test(source[j]!)) j += 1
			push(source.slice(i, j), "placeholder")
			i = j
			continue
		}

		// `?` (JDBC/MySQL), `:name` (named), `@name` (T-SQL / ClickHouse).
		if (ch === "?") {
			push(ch, "placeholder")
			i += 1
			continue
		}
		if ((ch === ":" || ch === "@") && isIdentifierStart(source[i + 1] ?? "")) {
			let j = i + 1
			while (j < source.length && isIdentifierPart(source[j]!)) j += 1
			push(source.slice(i, j), "placeholder")
			i = j
			continue
		}

		// ClickHouse's `{name:Type}`, which is how every query in `@maple/query-engine`
		// spells a parameter.
		if (ch === "{") {
			const close = source.indexOf("}", i + 1)
			if (close !== -1 && !source.slice(i + 1, close).includes("\n")) {
				push(source.slice(i, close + 1), "placeholder")
				i = close + 1
				continue
			}
		}

		if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
			let j = i
			while (j < source.length && /[0-9._]/.test(source[j]!)) j += 1
			if (/[eE]/.test(source[j] ?? "") && /[0-9+-]/.test(source[j + 1] ?? "")) {
				j += 2
				while (j < source.length && /[0-9]/.test(source[j]!)) j += 1
			}
			push(source.slice(i, j), "number")
			i = j
			continue
		}

		if (isIdentifierStart(ch)) {
			let j = i
			while (j < source.length && isIdentifierPart(source[j]!)) j += 1
			const word = source.slice(i, j)
			push(word, SQL_KEYWORDS.has(word.toLowerCase()) ? "keyword" : "plain")
			i = j
			continue
		}

		push(ch, "punctuation")
		i += 1
	}

	return tokens
}

/**
 * A single-pass XML/HTML scanner: element names and brackets as `tag`,
 * attribute names as `attr`, their quoted values as `string`, comments and
 * CDATA as themselves, and everything between elements as plain text.
 *
 * Nothing is validated. Unbalanced markup, an unterminated comment and a
 * half-truncated body all colour as far as they go and then fall back to plain,
 * because a body cut off at 8 kB by an instrumentation library is the normal
 * case, not the broken one.
 */
export function tokenizeXml(source: string): Array<CodeToken> {
	const tokens: Array<MutableToken> = []
	const push = pusher(tokens)
	let i = 0

	while (i < source.length) {
		const next = source.indexOf("<", i)
		if (next === -1) {
			push(source.slice(i), "plain")
			break
		}
		push(source.slice(i, next), "plain")
		i = next

		if (source.startsWith("<!--", i)) {
			const close = source.indexOf("-->", i + 4)
			const end = close === -1 ? source.length : close + 3
			push(source.slice(i, end), "comment")
			i = end
			continue
		}

		if (source.startsWith("<![CDATA[", i)) {
			const close = source.indexOf("]]>", i + 9)
			const end = close === -1 ? source.length : close + 3
			push(source.slice(i, end), "string")
			i = end
			continue
		}

		// `<?xml …?>` and `<!DOCTYPE …>`: one opaque tag each.
		if (source[i + 1] === "?" || source[i + 1] === "!") {
			const close = source.indexOf(">", i)
			const end = close === -1 ? source.length : close + 1
			push(source.slice(i, end), "tag")
			i = end
			continue
		}

		const closing = source[i + 1] === "/"
		push(closing ? "</" : "<", "tag")
		i += closing ? 2 : 1

		let j = i
		while (j < source.length && /[^\s/>]/.test(source[j]!)) j += 1
		push(source.slice(i, j), "tag")
		i = j

		// Inside the tag: attributes until the bracket closes.
		while (i < source.length && source[i] !== ">") {
			const ch = source[i]!
			if (/\s/.test(ch)) {
				const start = i
				while (i < source.length && /\s/.test(source[i]!)) i += 1
				push(source.slice(start, i), "plain")
				continue
			}
			if (ch === "/") {
				push("/", "tag")
				i += 1
				continue
			}
			if (ch === "=") {
				push("=", "punctuation")
				i += 1
				continue
			}
			if (ch === '"' || ch === "'") {
				const close = source.indexOf(ch, i + 1)
				const end = close === -1 ? source.length : close + 1
				push(source.slice(i, end), "string")
				i = end
				continue
			}
			const start = i
			while (i < source.length && /[^\s=/>"']/.test(source[i]!)) i += 1
			if (i === start) {
				push(source[i]!, "punctuation")
				i += 1
				continue
			}
			push(source.slice(start, i), "attr")
		}

		if (i < source.length) {
			push(">", "tag")
			i += 1
		}
	}

	return tokens
}

/** `key=value&key=value` — keys as keys, values as literals, separators dimmed. */
export function tokenizeForm(source: string): Array<CodeToken> {
	const tokens: Array<MutableToken> = []
	const push = pusher(tokens)

	// Handles both renditions: the raw single line and the pretty `k = v` lines.
	for (const [index, line] of source.split("\n").entries()) {
		if (index > 0) push("\n", "plain")
		let rest = line
		while (rest !== "") {
			const amp = rest.indexOf("&")
			const pair = amp === -1 ? rest : rest.slice(0, amp)
			const eq = pair.indexOf("=")
			if (eq === -1) {
				push(pair, "plain")
			} else {
				// The pretty rendition spaces the `=` out (`key = value`), so the
				// padding is split off and left uncoloured rather than swallowed into
				// the key or the literal beside it.
				const key = pair.slice(0, eq)
				const value = pair.slice(eq + 1)
				const keyText = key.trimEnd()
				push(keyText, "key")
				push(key.slice(keyText.length), "plain")
				push("=", "punctuation")
				const lead = value.length - value.trimStart().length
				push(value.slice(0, lead), "plain")
				push(value.slice(lead), "string")
			}
			if (amp === -1) break
			push("&", "punctuation")
			rest = rest.slice(amp + 1)
		}
	}

	return tokens
}

/**
 * Tokens for a language whose colouring is ours. JSON is absent on purpose —
 * it goes through `sugar-high`, which already knows that grammar — and falls
 * through to a single plain token so a caller passing it degrades to readable
 * text rather than throwing.
 */
export function tokenizeCode(text: string, language: CodeLanguage): Array<CodeToken> {
	if (text === "") return []
	switch (language) {
		case "sql":
			return tokenizeSql(text)
		case "xml":
			return tokenizeXml(text)
		case "form":
			return tokenizeForm(text)
		default:
			return [{ text, type: "plain" }]
	}
}

/**
 * Tokens regrouped into lines, so the renderer can number them, clamp them, and
 * wrap each one independently. Tokens that straddle a newline — a SQL block
 * comment, the text between two XML elements — are split at it.
 */
export function toLines(tokens: ReadonlyArray<CodeToken>): Array<Array<CodeToken>> {
	const lines: Array<Array<CodeToken>> = [[]]
	for (const token of tokens) {
		const parts = token.text.split("\n")
		for (const [index, part] of parts.entries()) {
			if (index > 0) lines.push([])
			if (part !== "") lines[lines.length - 1]!.push({ text: part, type: token.type })
		}
	}
	return lines
}

// Which attributes earn a block

/**
 * Attribute keys whose value is a payload by definition, whatever it happens to
 * contain. A one-line `SELECT 1` is still the query, and a `{}` request body is
 * still the body.
 */
const CODE_ATTRIBUTE_PATTERNS: ReadonlyArray<RegExp> = [
	/^db\.(query\.text|statement)$/,
	/^graphql\.(document|variables)$/,
	/^gen_ai\..*\.(messages|prompt|completion|arguments|result)$/,
	/^(http|rpc|messaging)\..*\.(body|payload)$/,
	/^mastra\..*\.(input|output)$/,
	/\.(body|payload|arguments|parameters)$/,
]

/**
 * Keys the panel already renders better elsewhere. A stacktrace has
 * `StackTrace`, and an error message has the error banner; pulling either into
 * a code block would show it twice.
 */
const CODE_ATTRIBUTE_EXCLUSIONS: ReadonlyArray<RegExp> = [/^exception\./, /^error\./]

/**
 * The language to render an attribute's value in, or `null` to leave it in the
 * plain attributes table.
 *
 * Two ways in. A key that names a payload always gets one. Anything else has to
 * earn it by being both *structured* and *big* — a short JSON scalar is a
 * perfectly good table row, and wrapping it in a bordered block with its own
 * toolbar is more chrome than content.
 */
export function codeAttributeLanguage(key: string, value: string): CodeLanguage | null {
	if (value === "") return null
	if (CODE_ATTRIBUTE_EXCLUSIONS.some((pattern) => pattern.test(key))) return null

	const language = detectLanguage(value)
	if (CODE_ATTRIBUTE_PATTERNS.some((pattern) => pattern.test(key))) {
		return language === "text" && value.length < CODE_BLOCK_MIN_LENGTH && !value.includes("\n")
			? null
			: language
	}

	if (language === "text") return null
	if (value.length < CODE_BLOCK_MIN_LENGTH && !value.includes("\n")) return null
	return language
}

/** Every attribute that should be lifted out of the table, in key order. */
export function collectCodeAttributes(
	attributes: Record<string, string>,
): Array<{ readonly key: string; readonly value: string; readonly language: CodeLanguage }> {
	const found: Array<{ key: string; value: string; language: CodeLanguage }> = []
	for (const [key, value] of Object.entries(attributes)) {
		const language = codeAttributeLanguage(key, value)
		if (language !== null) found.push({ key, value, language })
	}
	return found.sort((a, b) => a.key.localeCompare(b.key))
}
