// Sugar High, with JSON's keys given back their colour.

import { highlight } from "sugar-high"

/**
 * One token span of Sugar High's output: `<span class="sh__token--string"
 * style="color:var(--sh-string)">…</span>`. Token text is HTML-escaped by the
 * highlighter, so it can never contain a `<` and the non-greedy content match is
 * exact rather than hopeful.
 */
const TOKEN = /<span class="sh__token--([a-z]+)"([^>]*)>([^<]*)<\/span>/g

/** Sugar High's name for punctuation; `:` and `,` and the brackets all arrive as this. */
const PUNCTUATION = "sign"

interface Token {
	readonly type: string
	readonly text: string
	/** Offsets into the HTML, so a rewrite can splice rather than re-render. */
	readonly start: number
	readonly end: number
	readonly attributes: string
}

/**
 * JSON object keys, painted as keys.
 *
 * Sugar High is a JS highlighter, and its `property` token is the one it emits
 * for an *unquoted* key — `{ role: "x" }`. Every key in a JSON payload is
 * quoted, so the highlighter sees a string, and the drawer renders keys and
 * values in the same colour: `--sh-property` (→ `--code-key`) is defined,
 * aliased, and never used. The one distinction that makes a payload skimmable
 * is the one that goes missing.
 *
 * The fix is a pass over the HTML the highlighter already produced, not a
 * second tokenizer: a run of string tokens that a `:` follows is a key, and
 * re-tokenising JSON to learn that would be a parallel grammar to keep in step
 * with this one. A key arrives as three string tokens (`"`, its text, `"`), so
 * the whole run is re-labelled — colouring the text but not its quotes would
 * just be a different kind of wrong.
 *
 * Only the punctuation token `:` promotes a run, so a *value* containing a
 * colon (`"a:b"`, a URL, an embedded JSON document) is untouched: its colons are
 * inside a string token, where this pass cannot see them, and the token that
 * follows it is the `,` or `}` that ends the member.
 */
function promoteJsonKeys(html: string): string {
	const tokens: Array<Token> = []
	for (const match of html.matchAll(TOKEN)) {
		tokens.push({
			type: match[1]!,
			attributes: match[2]!,
			text: match[3]!,
			start: match.index,
			end: match.index + match[0].length,
		})
	}

	const keys = new Set<number>()
	let run: Array<number> = []
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!
		if (token.type === "string") {
			run.push(i)
			continue
		}
		// Whitespace — Sugar High's `space` token, or a blank stretch of anything
		// else — neither joins a run nor ends one: `{"a" : 1}` is still a key.
		if (token.text.trim() === "") continue
		if (run.length > 0 && token.type === PUNCTUATION && token.text === ":") {
			for (const index of run) keys.add(index)
		}
		run = []
	}
	if (keys.size === 0) return html

	const parts: Array<string> = []
	let cursor = 0
	for (const index of keys) {
		const token = tokens[index]!
		parts.push(html.slice(cursor, token.start))
		parts.push(
			`<span class="sh__token--property"${token.attributes.replace("--sh-string", "--sh-property")}>${token.text}</span>`,
		)
		cursor = token.end
	}
	parts.push(html.slice(cursor))
	return parts.join("")
}

/** Syntax-highlight a JSON string to HTML for the detail drawers' Raw views. */
export function highlightJson(code: string): string {
	return promoteJsonKeys(highlight(code))
}
