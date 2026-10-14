import { useCallback, useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { namespaceParam, persistNamespace, resolveNamespace, storedNamespace } from "../lib/namespace"
import { persistEnvironment } from "../lib/environment"
import { paramsAfterProjectChange } from "../lib/project-switch"
import { navigate, parseLocation, useQueryParams } from "../lib/router"
import { namespaceEnvironmentsQueryOptions } from "./use-local-environments"

/**
 * The active project (`service.namespace`) for the current view, and a setter.
 *
 * Read from the URL first and the remembered preference second; written to
 * both — the hash so the view stays a link, `localStorage` so the next
 * `maple start` opens on the project this one was left on.
 *
 * **Unlike the health-check toggle, the resolved value is mirrored back into
 * the URL.** That toggle names an exception and a plain link deliberately
 * carries no query string; this one names *which data the session is about*,
 * and half the views that honour it read `ns` from the hash directly. Leaving
 * the preference implicit would mean the header saying one project while a
 * view that reads the param showed all of them. The mirror is a `replace`, so
 * it normalizes the URL without adding a history entry to step back through.
 */
export function useNamespace(): readonly [string | undefined, (next: string | undefined) => Promise<void>] {
	const [query, setParams] = useQueryParams()
	const param = query.get("ns")
	const namespace = resolveNamespace(param)

	useEffect(() => {
		// Only ever writes what the reader already chose, and only when the URL is
		// silent — a link that says `ns=` (or says nothing while nothing is stored)
		// is left exactly as it arrived.
		if (!param && storedNamespace()) setParams({ ns: namespaceParam(namespace) })
	}, [param, namespace, setParams])

	const queryClient = useQueryClient()
	// A switch of project starts the page over (see `lib/project-switch.ts`):
	// page filters go, standing choices stay, and the environment stays only if
	// the new project reports it. A navigation, not a replace, so Back returns to
	// the filtered view that was left.
	const setNamespace = useCallback(
		async (next: string | undefined) => {
			persistNamespace(next)
			const current = parseLocation(window.location.hash.replace(/^#/, ""))
			const environment = current.query.get("env")
			const environments =
				environment && next
					? await queryClient
							.fetchQuery(namespaceEnvironmentsQueryOptions(next))
							.catch(() => undefined)
					: undefined
			// An unknown answer keeps the environment rather than silently dropping it.
			const keepEnvironment = environments === undefined || environments.includes(environment ?? "")
			if (!keepEnvironment) persistEnvironment(undefined)
			navigate(current.path, paramsAfterProjectChange(current.query, next, keepEnvironment))
		},
		[queryClient],
	)

	return [namespace, setNamespace] as const
}
