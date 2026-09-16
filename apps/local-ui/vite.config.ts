import { defineConfig } from "vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// The local Maple binary (`maple start`) serves this SPA from its own origin and
// owns the query and OTLP endpoints. In dev we run Vite standalone and proxy
// both route families to the running binary (default OTLP/HTTP port 4318).
const LOCAL_BINARY_URL = process.env.MAPLE_LOCAL_URL ?? "http://127.0.0.1:4318"

// The binary admits browser requests only from origins it knows (its own bind
// or advertise host, or local.maple.dev). A dev proxy pointed at a remote
// `maple start` forwards the page's `Origin` verbatim and is refused with 403,
// so drop it: a request without `Origin` is treated as server-to-server, which
// is what a proxy hop is.
const proxyTo = (target: string) => ({
	target,
	changeOrigin: true,
	configure: (proxy: { on: (event: "proxyReq", handler: (req: { removeHeader: (name: string) => void }) => void) => void }) => {
		proxy.on("proxyReq", (req) => req.removeHeader("origin"))
	},
})

export default defineConfig({
	plugins: [tailwindcss(), viteReact()],
	// `@maple/ui` and this app each resolve their own `react`/`react-dom` copy in
	// the monorepo; dedupe so Base UI components (Popover, etc.) share a single
	// React instance — otherwise hooks throw "more than one copy of React".
	resolve: {
		dedupe: ["react", "react-dom"],
		tsconfigPaths: true,
	},
	// Emit a static SPA. `dist/` is both deployed to local.maple.dev (the default
	// UI) and inlined into the `maple` binary as the `--offline` fallback (via
	// scripts/gen-ui-embed.ts → apps/cli/src/server/ui-embed.gen.ts).
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		proxy: {
			"/local": proxyTo(LOCAL_BINARY_URL),
			// Keep the connection hint same-origin in dev: exporters can post to
			// Vite's displayed origin and reach the binary just like /local/query.
			"/v1": proxyTo(LOCAL_BINARY_URL),
			// The connection banner polls the binary's liveness endpoint.
			"/health": proxyTo(LOCAL_BINARY_URL),
		},
	},
})
