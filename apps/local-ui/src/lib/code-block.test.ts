import { describe, expect, it } from "vitest"
import {
	CODE_BLOCK_MIN_LENGTH,
	CODE_PARSE_LIMIT,
	CODE_RENDER_LIMIT,
	codeAttributeLanguage,
	collectCodeAttributes,
	detectLanguage,
	formatForm,
	formatJson,
	prepareCode,
	toLines,
	tokenizeCode,
	tokenizeForm,
	tokenizeSql,
	tokenizeXml,
	type CodeToken,
	type CodeTokenType,
} from "./code-block"
import { highlightJson } from "./highlight"

/** The tokens of one type, concatenated — what a reader would see in that colour. */
function typed(tokens: ReadonlyArray<CodeToken>, type: CodeTokenType): Array<string> {
	return tokens.filter((token) => token.type === type).map((token) => token.text)
}

/** Round-trip guard: a tokenizer may never drop or invent a character. */
function joined(tokens: ReadonlyArray<CodeToken>): string {
	return tokens.map((token) => token.text).join("")
}

describe("detectLanguage", () => {
	it("calls an object or an array JSON", () => {
		expect(detectLanguage('{"a":1}')).toBe("json")
		expect(detectLanguage(' [1, 2, 3]\n')).toBe("json")
	})

	it("holds the JSON verdict for a body it cannot parse, and drops it for one with no closing delimiter", () => {
		// Both delimiters present, middle mangled: still coloured as JSON, and
		// `prepareCode` simply offers no pretty rendition.
		expect(detectLanguage('{"a": }')).toBe("json")
		// A body cut off mid-string has no closing delimiter to sniff, so it
		// renders as text rather than being guessed at.
		expect(detectLanguage('{"messages":[{"role":"user"')).toBe("text")
	})

	it("recognises the statement verbs, in any case, through a leading comment", () => {
		expect(detectLanguage("SELECT id FROM users WHERE id = $1")).toBe("sql")
		expect(detectLanguage("insert into events (a) values (1)")).toBe("sql")
		expect(detectLanguage("WITH t AS (SELECT 1) SELECT * FROM t")).toBe("sql")
		expect(detectLanguage("-- name: GetUser\nSELECT 1 FROM dual")).toBe("sql")
		expect(detectLanguage("/* app=api */ UPDATE users SET name = 'x'")).toBe("sql")
		expect(detectLanguage("BEGIN;")).toBe("sql")
	})

	it("does not read an English sentence that opens with a SQL verb as SQL", () => {
		// The opener alone is not enough; a real statement always carries a second
		// keyword, and an error message painted as SQL is worse than plain prose.
		expect(detectLanguage("Select a plan to continue")).toBe("text")
		expect(detectLanguage("Update failed after 3 attempts")).toBe("text")
	})

	it("calls markup XML, and a lone comparison operator text", () => {
		expect(detectLanguage("<soap:Envelope><Body/></soap:Envelope>")).toBe("xml")
		expect(detectLanguage("<!doctype html><html></html>")).toBe("xml")
		expect(detectLanguage("<redacted")).toBe("text")
		expect(detectLanguage("< 3")).toBe("text")
	})

	it("calls an encoded form a form, and a bare pair text", () => {
		expect(detectLanguage("grant_type=client_credentials&scope=read")).toBe("form")
		expect(detectLanguage("q=hello%20world")).toBe("form")
		expect(detectLanguage("q=hello+world")).toBe("form")
		// One unencoded pair is as likely to be a label as a payload.
		expect(detectLanguage("env=prod")).toBe("text")
		// A form is a single line by construction.
		expect(detectLanguage("a=1&b=2\nc=3")).toBe("text")
	})

	it("falls back to text, including for the empty string", () => {
		expect(detectLanguage("")).toBe("text")
		expect(detectLanguage("   \n ")).toBe("text")
		expect(detectLanguage("connection reset by peer")).toBe("text")
	})
})

describe("formatJson", () => {
	it("pretty-prints at two spaces", () => {
		expect(formatJson('{"a":1,"b":[2]}')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}')
	})

	it("returns null rather than throwing on malformed input", () => {
		expect(formatJson('{"a": }')).toBeNull()
	})

	it("refuses to parse past the limit", () => {
		// Valid JSON, but far too large to parse just to decide how to paint it.
		const huge = `[${"1,".repeat(CODE_PARSE_LIMIT)}1]`
		expect(huge.length).toBeGreaterThan(CODE_PARSE_LIMIT)
		expect(formatJson(huge)).toBeNull()
	})
})

describe("formatForm", () => {
	it("decodes each pair onto its own line", () => {
		expect(formatForm("q=hello+world&lang=en%2DGB")).toBe("q = hello world\nlang = en-GB")
	})

	it("shows the bytes as sent when the escape is malformed", () => {
		expect(formatForm("q=100%")).toBe("q = 100%")
	})
})

describe("prepareCode", () => {
	it("prefers the pretty rendition and offers the toggle", () => {
		const prepared = prepareCode('{"a":1}')
		expect(prepared.language).toBe("json")
		expect(prepared.text).toBe('{\n  "a": 1\n}')
		expect(prepared.canPretty).toBe(true)
		expect(prepared.lineCount).toBe(3)
	})

	it("hands back the raw text when pretty is declined", () => {
		expect(prepareCode('{"a":1}', { pretty: false }).text).toBe('{"a":1}')
	})

	it("offers no toggle when the value is already its own pretty form", () => {
		const already = '{\n  "a": 1\n}'
		expect(prepareCode(already).canPretty).toBe(false)
	})

	it("copies the original, never the formatted or truncated text", () => {
		const oversized = `"${"x".repeat(CODE_RENDER_LIMIT + 500)}"`
		const prepared = prepareCode(`[${oversized}]`)
		expect(prepared.truncated).toBe(true)
		expect(prepared.text.length).toBe(CODE_RENDER_LIMIT)
		expect(prepared.copyText.length).toBeGreaterThan(CODE_RENDER_LIMIT)
		expect(prepared.copyText).toBe(`[${oversized}]`)
	})

	it("honours an explicit language over detection", () => {
		expect(prepareCode("anything at all", { language: "sql" }).language).toBe("sql")
	})
})

describe("tokenizeSql", () => {
	it("separates keywords, literals, numbers and identifiers", () => {
		const tokens = tokenizeSql("SELECT name FROM users WHERE age > 30 AND tag = 'a''b'")
		expect(typed(tokens, "keyword")).toEqual(["SELECT", "FROM", "WHERE", "AND"])
		expect(typed(tokens, "number")).toEqual(["30"])
		// The doubled quote is SQL's own escape and stays inside one literal.
		expect(typed(tokens, "string")).toEqual(["'a''b'"])
		expect(joined(tokens)).toBe("SELECT name FROM users WHERE age > 30 AND tag = 'a''b'")
	})

	it("marks every placeholder dialect as a placeholder", () => {
		const tokens = tokenizeSql("SELECT $1, $22, ?, :name, @tenant, {orgId:String} FROM t")
		expect(typed(tokens, "placeholder")).toEqual([
			"$1",
			"$22",
			"?",
			":name",
			"@tenant",
			"{orgId:String}",
		])
	})

	it("keeps both comment spellings whole", () => {
		const tokens = tokenizeSql("-- why\nSELECT 1 /* inline\nstill */ FROM t")
		expect(typed(tokens, "comment")).toEqual(["-- why", "/* inline\nstill */"])
	})

	it("reads a quoted identifier as a key, not a literal", () => {
		const tokens = tokenizeSql('SELECT "user name" FROM `t`')
		expect(typed(tokens, "key")).toEqual(['"user name"', "`t`"])
		expect(typed(tokens, "string")).toEqual([])
	})

	it("terminates on an unclosed literal rather than looping", () => {
		const tokens = tokenizeSql("SELECT 'unterminated")
		expect(joined(tokens)).toBe("SELECT 'unterminated")
	})
})

describe("tokenizeXml", () => {
	it("splits tags, attributes, values and text", () => {
		const tokens = tokenizeXml('<a href="/x" checked>hi</a>')
		// Adjacent same-type tokens merge, so the bracket and the element name are
		// one span — the point is the colour, not the span count.
		expect(typed(tokens, "tag")).toEqual(["<a", ">", "</a>"])
		expect(typed(tokens, "attr")).toEqual(["href", "checked"])
		expect(typed(tokens, "string")).toEqual(['"/x"'])
		expect(typed(tokens, "plain")).toEqual([" ", " ", "hi"])
		expect(joined(tokens)).toBe('<a href="/x" checked>hi</a>')
	})

	it("keeps declarations, comments and CDATA in one piece", () => {
		const source = '<?xml version="1.0"?><!-- note --><![CDATA[<raw>]]>'
		const tokens = tokenizeXml(source)
		expect(typed(tokens, "comment")).toEqual(["<!-- note -->"])
		expect(typed(tokens, "string")).toEqual(["<![CDATA[<raw>]]>"])
		expect(joined(tokens)).toBe(source)
	})

	it("colours as far as a truncated body goes and stops", () => {
		const tokens = tokenizeXml('<Envelope><Body><op arg="1')
		expect(joined(tokens)).toBe('<Envelope><Body><op arg="1')
	})

	it("closes a self-closing tag without inventing a bracket", () => {
		expect(joined(tokenizeXml("<br/>"))).toBe("<br/>")
	})
})

describe("tokenizeForm", () => {
	it("splits keys from values on both renditions", () => {
		const raw = tokenizeForm("a=1&b=two")
		expect(typed(raw, "key")).toEqual(["a", "b"])
		expect(typed(raw, "string")).toEqual(["1", "two"])
		expect(joined(raw)).toBe("a=1&b=two")

		const pretty = tokenizeForm("a = 1\nb = two")
		expect(typed(pretty, "key")).toEqual(["a", "b"])
		expect(typed(pretty, "string")).toEqual(["1", "two"])
		expect(joined(pretty)).toBe("a = 1\nb = two")
	})
})

describe("tokenizeCode", () => {
	it("falls through to one plain token for text and for JSON", () => {
		// JSON is Sugar High's job; the fallback keeps a caller that passes it
		// readable rather than throwing.
		expect(tokenizeCode('{"a":1}', "json")).toEqual([{ text: '{"a":1}', type: "plain" }])
		expect(tokenizeCode("plain words", "text")).toEqual([{ text: "plain words", type: "plain" }])
		expect(tokenizeCode("", "sql")).toEqual([])
	})
})

describe("toLines", () => {
	it("splits tokens that straddle a newline and keeps empty lines", () => {
		const lines = toLines([
			{ text: "a\n", type: "keyword" },
			{ text: "\nb", type: "plain" },
		])
		expect(lines.map((line) => line.map((token) => token.text).join(""))).toEqual(["a", "", "b"])
		expect(lines[0]![0]!.type).toBe("keyword")
	})
})

describe("codeAttributeLanguage", () => {
	it("always blocks a key that names a payload, however short", () => {
		expect(codeAttributeLanguage("db.query.text", "SELECT 1 FROM t")).toBe("sql")
		expect(codeAttributeLanguage("http.request.body", "{}")).toBe("json")
		expect(codeAttributeLanguage("mastra.agent.output", '{"a":1}')).toBe("json")
		expect(codeAttributeLanguage("gen_ai.input.messages", "[]")).toBe("json")
	})

	it("leaves a short structured scalar in the table", () => {
		expect(codeAttributeLanguage("custom.meta", '{"a":1}')).toBeNull()
		expect(codeAttributeLanguage("custom.meta", `{"a":"${"x".repeat(CODE_BLOCK_MIN_LENGTH)}"}`)).toBe(
			"json",
		)
	})

	it("never takes an exception or error key — those have their own renderers", () => {
		expect(codeAttributeLanguage("exception.stacktrace", "Error: x\n  at y (/a.ts:1:1)")).toBeNull()
		expect(codeAttributeLanguage("error.message", '{"code":"E"}')).toBeNull()
	})

	it("leaves prose and empty values alone", () => {
		expect(codeAttributeLanguage("http.route", "/users/:id")).toBeNull()
		expect(codeAttributeLanguage("db.query.text", "")).toBeNull()
	})
})

describe("collectCodeAttributes", () => {
	it("returns only the payload keys, in key order", () => {
		const found = collectCodeAttributes({
			"http.method": "GET",
			"db.query.text": "SELECT 1 FROM t",
			"exception.stacktrace": "Error: x",
			"http.request.body": '{"a":1}',
		})
		expect(found.map((entry) => entry.key)).toEqual(["db.query.text", "http.request.body"])
		expect(found.map((entry) => entry.language)).toEqual(["sql", "json"])
	})
})

// The JSON half of the same palette. `code-block.ts` tokenizes SQL, XML and
// forms itself; JSON goes through Sugar High, and `highlightJson` is the one
// place its output is corrected — so the two halves are tested together.

describe("highlightJson", () => {
	const decode = (html: string): string =>
		html.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")

	/** Every token of a class, in order, with Sugar High's entities decoded. */
	const tokens = (json: string, type: string): Array<string> => {
		const found: Array<string> = []
		const pattern = new RegExp(`<span class="sh__token--${type}"[^>]*>([^<]*)</span>`, "g")
		for (const match of highlightJson(json).matchAll(pattern)) found.push(decode(match[1]!))
		return found
	}

	/** What a reader sees in one colour: the tokens, without the quote glyphs. */
	const painted = (json: string, type: string): Array<string> =>
		tokens(json, type).filter((text) => text !== '"')

	// Sugar High's `property` token is for unquoted JS keys, so a JSON payload
	// came back with keys and values in the same colour and `--sh-property`
	// unused. This is the whole point of the pass.
	it("paints object keys as keys and their string values as strings", () => {
		const json = '{"role":"system","n":1,"nested":{"k":[true,"x"]}}'
		expect(painted(json, "property")).toEqual(["role", "n", "nested", "k"])
		expect(painted(json, "string")).toEqual(["system", "x"])
	})

	// A key arrives as three tokens — `"`, its text, `"` — and colouring the
	// text but not its quotes would be a different kind of wrong.
	it("takes the key's quotes with it, styled for the key variable", () => {
		expect(tokens('{"a":1}', "property")).toEqual(['"', "a", '"'])
		expect(highlightJson('{"a":1}')).toContain(
			'<span class="sh__token--property" style="color:var(--sh-property)">a</span>',
		)
	})

	it("ignores whitespace between a key and its colon", () => {
		expect(painted('{\n  "a" : 1\n}', "property")).toEqual(["a"])
	})

	// The colons that matter are punctuation tokens. A colon inside a value is
	// part of a string token, where this pass cannot see it — which is the
	// reason to work on the tokens rather than on the text.
	it("leaves a value that contains a colon a value", () => {
		expect(painted('{"a":"a:b","b:c":"x"}', "property")).toEqual(["a", "b:c"])
		expect(painted('{"a":"a:b","b:c":"x"}', "string")).toEqual(["a:b", "x"])
		expect(painted('{"url":"https://shop.example/p"}', "string")).toEqual(["https://shop.example/p"])
	})

	// An escaped quote splits the value into a run of string tokens, and the run
	// is followed by the `}` that ends the member, not by a colon.
	it("leaves a JSON document embedded in a string value alone", () => {
		const json = String.raw`{"k":"{\"a\":\"b\"}"}`
		expect(painted(json, "property")).toEqual(["k"])
		expect(tokens(json, "string").join("")).toBe(String.raw`"{\"a\":\"b\"}"`)
	})

	// The rewrite splices HTML by offset; a dropped or duplicated character
	// would be invisible in the assertions above.
	it("renders every character of the input, once", () => {
		const json = '{"a":"a:b","n":1,"nested":{"k":[true,"x"]}}'
		const text = decode(highlightJson(json).replace(/<[^>]*>/g, ""))
		expect(text).toBe(json)
	})
})
