import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { setTheme } from "@maple/ui/hooks/use-theme"
import { App } from "./App"
import { shouldRetryLocalQuery } from "./lib/query"
import "./styles.css"

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			// Lists are anchored to a time window and offer a "new data" refresh
			// instead; refetching every page on focus would re-run them all.
			refetchOnWindowFocus: false,
			staleTime: 30_000,
			retry: shouldRetryLocalQuery,
		},
	},
})

// Harbr fork: always dark (upstream v0.0.23 follows the OS theme). The markup
// ships `class="dark"`; `setTheme` keeps chart colors in step with it.
setTheme("dark", { persist: false })

const container = document.getElementById("app")
if (container) {
	createRoot(container).render(
		<StrictMode>
			<QueryClientProvider client={queryClient}>
				<App />
			</QueryClientProvider>
		</StrictMode>,
	)
}
