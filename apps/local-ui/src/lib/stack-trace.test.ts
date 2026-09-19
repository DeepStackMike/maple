import { describe, expect, it } from "vitest"
import {
	isFrameworkFrame,
	parseStackTrace,
	partitionFrames,
	shortenFilePath,
	type StackFrame,
} from "./stack-trace"

const frameAt = (frames: ReadonlyArray<StackFrame>, index: number): StackFrame => frames[index]!

describe("V8 stacks", () => {
	const stack = [
		"TypeError: Cannot read properties of undefined (reading 'id')",
		"    at handleCheckout (/app/src/routes/checkout.ts:42:19)",
		"    at async Server.fetch (/app/src/server.ts:18:3)",
		"    at new Client (/app/node_modules/pg/lib/client.js:88:1)",
		"    at /app/src/boot.ts:7:1",
		"    at <anonymous>",
	].join("\n")

	it("splits the header into a type and a message", () => {
		const parsed = parseStackTrace(stack)
		expect(parsed.kind).toBe("v8")
		expect(parsed.header).toEqual({
			type: "TypeError",
			message: "Cannot read properties of undefined (reading 'id')",
		})
	})

	it("reads the function, file, line and column off a named frame", () => {
		const { frames } = parseStackTrace(stack)
		expect(frameAt(frames, 0)).toMatchObject({
			fn: "handleCheckout",
			modifier: null,
			file: "/app/src/routes/checkout.ts",
			line: 42,
			column: 19,
			framework: false,
		})
	})

	it("lifts the `async` and `new` prefixes off the function name", () => {
		const { frames } = parseStackTrace(stack)
		expect(frameAt(frames, 1)).toMatchObject({ modifier: "async", fn: "Server.fetch" })
		expect(frameAt(frames, 2)).toMatchObject({ modifier: "new", fn: "Client" })
	})

	it("parses a bare location with no function name", () => {
		const { frames } = parseStackTrace(stack)
		expect(frameAt(frames, 3)).toMatchObject({
			fn: "",
			file: "/app/src/boot.ts",
			line: 7,
			column: 1,
		})
	})

	it("keeps an anonymous frame rather than dropping it", () => {
		const { frames } = parseStackTrace(stack)
		expect(frames).toHaveLength(5)
		expect(frameAt(frames, 4)).toMatchObject({ fn: "", file: "<anonymous>", line: null })
	})

	// A message with a colon in it is not a second `Type:` boundary — the
	// identifier before the colon can hold no whitespace.
	it("does not split a message that merely contains a colon", () => {
		const parsed = parseStackTrace("Error: upstream said: 502 Bad Gateway\n    at f (/a/b.ts:1:1)")
		expect(parsed.header).toEqual({ type: "Error", message: "upstream said: 502 Bad Gateway" })
	})

	it("keeps a multi-line message above the first frame", () => {
		const parsed = parseStackTrace(
			[
				"AssertionError: expected 1 to equal 2",
				"  - expected",
				"  + actual",
				"    at t (/a/b.ts:1:1)",
			].join("\n"),
		)
		expect(parsed.header?.message).toBe("expected 1 to equal 2\n- expected\n+ actual")
		expect(parsed.frames).toHaveLength(1)
	})

	it("parses a stack with no header line at all", () => {
		const parsed = parseStackTrace("    at f (/a/b.ts:1:1)\n    at g (/a/c.ts:2:2)")
		expect(parsed.kind).toBe("v8")
		expect(parsed.header).toBeNull()
		expect(parsed.frames).toHaveLength(2)
	})

	it("parses a frame with a line but no column", () => {
		const { frames } = parseStackTrace("Error: x\n    at f (/a/b.ts:9)")
		expect(frameAt(frames, 0)).toMatchObject({ file: "/a/b.ts", line: 9, column: null })
	})

	it("parses a minified browser URL, port and all", () => {
		const { frames } = parseStackTrace(
			"Error: x\n    at o (https://app.example.com:8443/assets/chunks/index-a1b2c3d4.js:1:24680)",
		)
		expect(frameAt(frames, 0)).toMatchObject({
			fn: "o",
			file: "https://app.example.com:8443/assets/chunks/index-a1b2c3d4.js",
			line: 1,
			column: 24680,
		})
	})
})

describe("framework frames", () => {
	it("marks dependency and runtime locations", () => {
		expect(isFrameworkFrame("/app/node_modules/pg/lib/client.js")).toBe(true)
		expect(isFrameworkFrame("node:internal/main/run_main_module")).toBe(true)
		expect(isFrameworkFrame("bun:main")).toBe(true)
		expect(isFrameworkFrame("/$bunfs/root/bun:wrap")).toBe(true)
		expect(isFrameworkFrame("<anonymous>")).toBe(true)
	})

	// `Object.<anonymous>` is how V8 names the top level of a CommonJS module, so
	// matching the function name would file every entry point under "framework".
	it("judges the location, not the function name", () => {
		expect(isFrameworkFrame("/app/src/index.js")).toBe(false)
		const { frames } = parseStackTrace("Error: x\n    at Object.<anonymous> (/app/src/index.js:1:1)")
		expect(frameAt(frames, 0)).toMatchObject({ fn: "Object.<anonymous>", framework: false })
	})

	it("partitions in source order", () => {
		const { frames } = parseStackTrace(
			[
				"Error: x",
				"    at a (/app/a.ts:1:1)",
				"    at b (/app/node_modules/x/b.js:2:2)",
				"    at c (/app/c.ts:3:3)",
				"    at d (node:internal/process/task_queues:95:5)",
			].join("\n"),
		)
		const { app, framework } = partitionFrames(frames)
		expect(app.map((f) => f.fn)).toEqual(["a", "c"])
		expect(framework.map((f) => f.fn)).toEqual(["b", "d"])
	})
})

describe("python tracebacks", () => {
	const traceback = [
		"Traceback (most recent call last):",
		'  File "/app/main.py", line 12, in <module>',
		"    do_thing()",
		'  File "/srv/venv/lib/python3.12/site-packages/flask/app.py", line 1488, in __call__',
		"    return self.wsgi_app(environ, start_response)",
		'  File "/app/lib.py", line 5, in do_thing',
		'    raise ValueError("boom")',
		"ValueError: boom",
	].join("\n")

	it("reads each File/line/in frame in source order", () => {
		const parsed = parseStackTrace(traceback)
		expect(parsed.kind).toBe("python")
		expect(parsed.frames.map((f) => [f.file, f.line, f.fn])).toEqual([
			["/app/main.py", 12, "<module>"],
			["/srv/venv/lib/python3.12/site-packages/flask/app.py", 1488, "__call__"],
			["/app/lib.py", 5, "do_thing"],
		])
	})

	it("takes the trailing unindented line as the header", () => {
		expect(parseStackTrace(traceback).header).toEqual({ type: "ValueError", message: "boom" })
	})

	it("handles a frame with no `in <fn>` and an exception with no message", () => {
		const parsed = parseStackTrace(
			["Traceback (most recent call last):", '  File "/app/main.py", line 3', "KeyboardInterrupt"].join(
				"\n",
			),
		)
		expect(parsed.frames).toHaveLength(1)
		expect(parsed.frames[0]).toMatchObject({ fn: "", file: "/app/main.py", line: 3 })
		expect(parsed.header).toEqual({ type: "", message: "KeyboardInterrupt" })
	})
})

describe("unparseable input", () => {
	it("falls back rather than throwing", () => {
		const garbage = '{"level":"fatal","msg":"segfault"} ??? ==== <<<>>>\n\tnot a stack at all'
		const parsed = parseStackTrace(garbage)
		expect(parsed.kind).toBe("unknown")
		expect(parsed.frames).toEqual([])
		expect(parsed.header).toBeNull()
		expect(parsed.raw).toBe(garbage)
	})

	it("treats a bare message with no frames as unparsed", () => {
		// The `<pre>` fallback renders this identically, so claiming a parse would
		// buy a header row and nothing under it.
		expect(parseStackTrace("Error: boom").kind).toBe("unknown")
	})

	it("returns an empty unknown stack for empty input", () => {
		expect(parseStackTrace("   ")).toMatchObject({ kind: "unknown", frames: [], header: null })
	})
})

describe("shortenFilePath", () => {
	it("leaves a short path alone", () => {
		expect(shortenFilePath("/app/src/index.ts")).toBe("/app/src/index.ts")
	})

	it("keeps the last two segments of a long bundle URL", () => {
		expect(shortenFilePath("https://app.example.com/assets/chunks/index-a1b2c3d4.js")).toBe(
			"chunks/index-a1b2c3d4.js",
		)
	})

	it("leaves a long path alone when there is nothing to trim to", () => {
		const flat = `/${"a".repeat(60)}.js`
		expect(shortenFilePath(flat)).toBe(flat)
	})
})
