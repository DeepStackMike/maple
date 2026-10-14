// Filter the Logs page in or out by any attribute value.
//
// Ported from the hosted app's `lib/logs/log-attribute-filters.ts` so the two
// share one URL spelling: a shared hosted link's `attrs` entries mean the same
// thing here. Local keeps them as repeated `attrs` params in the hash
// (`#/logs?attrs=log:http.route=/api&attrs=!res:k8s.pod.name=web-1`).

/** The query param the filters ride in, one entry per filter. */
export const ATTRS_PARAM = "attrs"

/** Which map an attribute lives in: `LogAttributes` or `ResourceAttributes`. */
export type LogAttributeSource = "log" | "resource"

export interface LogAttributeFilter {
	readonly source: LogAttributeSource
	readonly key: string
	readonly value: string
	readonly negated: boolean
}

/**
 * URL spelling of one filter: `[!]log:<key>=<value>` or `[!]res:<key>=<value>`.
 * The value is everything after the first `=`, so it may hold `=` itself; the
 * key escapes `%` and `=`.
 */
export function encodeLogAttributeFilter(filter: LogAttributeFilter): string {
	const key = filter.key.replace(/%/g, "%25").replace(/=/g, "%3D")
	const scope = filter.source === "resource" ? "res" : "log"
	return `${filter.negated ? "!" : ""}${scope}:${key}=${filter.value}`
}

const ENTRY = /^(!?)(log|res):([^=]+)=([\s\S]*)$/

/** `undefined` for an entry that is not in the `attrs` spelling, so a hand-edited URL drops it. */
export function decodeLogAttributeFilter(entry: string): LogAttributeFilter | undefined {
	const match = ENTRY.exec(entry)
	if (!match) return undefined
	const [, bang, scope, rawKey = "", value = ""] = match
	const key = rawKey.replace(/%(25|3D)/gi, (escape) => (escape === "%25" ? "%" : "="))
	return { source: scope === "res" ? "resource" : "log", key, value, negated: bang === "!" }
}

export function decodeLogAttributeFilters(entries: ReadonlyArray<string> | undefined): LogAttributeFilter[] {
	return (entries ?? []).flatMap((entry) => {
		const filter = decodeLogAttributeFilter(entry)
		return filter ? [filter] : []
	})
}

/**
 * Adds a filter to the `attrs` list. The same key and value in the other
 * polarity is replaced rather than kept beside it, since both together match
 * nothing; adding one that is already there moves it to the end, once.
 */
export function addLogAttributeFilter(
	entries: ReadonlyArray<string> | undefined,
	filter: LogAttributeFilter,
): string[] {
	const opposite = encodeLogAttributeFilter({ ...filter, negated: !filter.negated })
	const next = encodeLogAttributeFilter(filter)
	const kept = (entries ?? []).filter((entry) => entry !== opposite && entry !== next)
	return [...kept, next]
}

/** The `attrs` list without one entry. */
export function removeLogAttributeFilter(
	entries: ReadonlyArray<string> | undefined,
	entry: string,
): string[] {
	return (entries ?? []).filter((candidate) => candidate !== entry)
}

/** One exact-match predicate, the `AttributeFilter` shape the logs builders take. */
export interface LogAttributeQueryFilter {
	readonly key: string
	readonly value: string
	readonly mode: "equals"
	readonly negated?: boolean
}

/** The builder fields for the `attrs` entries, each `undefined` when it has none. */
export function logAttributeQueryFilters(entries: ReadonlyArray<string> | undefined): {
	attributeFilters: LogAttributeQueryFilter[] | undefined
	resourceAttributeFilters: LogAttributeQueryFilter[] | undefined
} {
	const filters = decodeLogAttributeFilters(entries)
	const toQuery = (source: LogAttributeSource): LogAttributeQueryFilter[] | undefined => {
		const matching = filters
			.filter((filter) => filter.source === source)
			.map((filter): LogAttributeQueryFilter =>
				filter.negated
					? { key: filter.key, value: filter.value, mode: "equals", negated: true }
					: { key: filter.key, value: filter.value, mode: "equals" },
			)
		return matching.length > 0 ? matching : undefined
	}
	return { attributeFilters: toQuery("log"), resourceAttributeFilters: toQuery("resource") }
}

/** Chip label for one filter: the key, marked when it reads the resource map. */
export function logAttributeFilterLabel(filter: LogAttributeFilter): string {
	return filter.source === "resource" ? `${filter.key} (resource)` : filter.key
}
