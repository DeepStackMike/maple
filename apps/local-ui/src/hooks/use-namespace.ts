import { useCallback, useEffect } from "react"
import { namespaceParam, persistNamespace, resolveNamespace, storedNamespace } from "../lib/namespace"
import { useQueryParams } from "../lib/router"

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
export function useNamespace(): readonly [string | undefined, (next: string | undefined) => void] {
	const [query, setParams] = useQueryParams()
	const param = query.get("ns")
	const namespace = resolveNamespace(param)

	useEffect(() => {
		// Only ever writes what the reader already chose, and only when the URL is
		// silent — a link that says `ns=` (or says nothing while nothing is stored)
		// is left exactly as it arrived.
		if (!param && storedNamespace()) setParams({ ns: namespaceParam(namespace) })
	}, [param, namespace, setParams])

	const setNamespace = useCallback(
		(next: string | undefined) => {
			persistNamespace(next)
			setParams({ ns: namespaceParam(next) })
		},
		[setParams],
	)

	return [namespace, setNamespace] as const
}
