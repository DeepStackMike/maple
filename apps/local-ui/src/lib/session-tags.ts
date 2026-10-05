// Rule-based session tags: the quality tier the warehouse decides for every
// session (bot, bounce, idle, glance, engaged) plus two independent visitor
// traits (signed_in, new_visitor). Mirrors the hosted app's
// `apps/web/src/components/replays/session-tags.ts`.
//
// The vocabulary lives in `@maple/domain/query-engine`, which this package does
// not depend on directly. It is restated here and pinned to the query engine's
// own `tags` option type below, so a tag added or renamed upstream is a compile
// error here rather than a silently unfilterable option.

import type { SessionReplaysListOpts, SessionReplaysListOutput } from "@maple/query-engine/ch"

/** Exactly one per session, first match wins. Same order as the domain's. */
export const SESSION_QUALITY_TAGS = ["bot", "bounce", "idle", "glance", "engaged"] as const

/** Every tag a session can carry: its quality plus independent traits. */
export const SESSION_TAGS = [...SESSION_QUALITY_TAGS, "signed_in", "new_visitor"] as const
export type SessionTag = (typeof SESSION_TAGS)[number]

// Both directions, so neither side can grow a tag the other lacks.
type EngineSessionTag = NonNullable<SessionReplaysListOpts["tags"]>[number]
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const _vocabularyMatchesEngine: Exact<SessionTag, EngineSessionTag> = true
void _vocabularyMatchesEngine

/** The domain's quality cutoffs (`SESSION_TAG_THRESHOLDS`), for the descriptions. */
const SESSION_TAG_THRESHOLDS = {
	bounceMaxMs: 5_000,
	glanceMaxMs: 30_000,
	glanceMaxClicks: 2,
} as const

const seconds = (ms: number) => `${ms / 1000}s`

export const SESSION_TAG_LABELS = {
	engaged: "Engaged",
	glance: "Glance",
	idle: "Idle tab",
	bounce: "Bounce",
	bot: "Bot",
	signed_in: "Signed in",
	new_visitor: "New visitor",
} satisfies Record<SessionTag, string>

export const SESSION_TAG_DESCRIPTIONS = {
	engaged: "Everything that is not a bot, bounce, idle tab or glance",
	glance: `One page, at most ${SESSION_TAG_THRESHOLDS.glanceMaxClicks} clicks, under ${seconds(SESSION_TAG_THRESHOLDS.glanceMaxMs)}`,
	idle: "One page, no clicks, no errors",
	bounce: `Under ${seconds(SESSION_TAG_THRESHOLDS.bounceMaxMs)} with no clicks`,
	bot: "Crawler, headless browser or uptime check",
	signed_in: "Identified with identify()",
	new_visitor: "First visit from this browser",
} satisfies Record<SessionTag, string>

/** Pill colours: green for the sessions worth opening, a hue per noise tier, and
 *  blue/pink for the visitor traits. */
export const SESSION_TAG_STYLES = {
	engaged: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
	glance: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
	idle: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
	bounce: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
	bot: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
	signed_in: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
	new_visitor: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
} satisfies Record<SessionTag, string>

/** Dot colour per tag, for places too small for a pill (the facet, run summaries). */
export const SESSION_TAG_DOTS = {
	engaged: "bg-emerald-500",
	glance: "bg-sky-500",
	idle: "bg-amber-500",
	bounce: "bg-orange-500",
	bot: "bg-violet-500",
	signed_in: "bg-blue-500",
	new_visitor: "bg-fuchsia-500",
} satisfies Record<SessionTag, string>

/** Display order: the tier you most likely want first, then the traits. */
export const SESSION_TAG_ORDER: ReadonlyArray<SessionTag> = SESSION_TAGS

/** `name` as a tag, or undefined for anything the vocabulary does not know. */
export const asSessionTag = (name: string): SessionTag | undefined => SESSION_TAGS.find((tag) => tag === name)

export const isQualityTier = (tag: SessionTag): boolean =>
	SESSION_QUALITY_TAGS.some((quality) => quality === tag)

/**
 * The valid tags in the `tags` hash param (comma-separated), in display order.
 * A hand-edited URL cannot send the query an unknown tag.
 */
export function sessionTagsFromParam(param: string | null | undefined): Array<SessionTag> {
	if (!param) return []
	const names = new Set(param.split(","))
	return SESSION_TAG_ORDER.filter((tag) => names.has(tag))
}

/** The `tags` param for a selection, or `null` to drop it from the URL. */
export const sessionTagsToParam = (tags: ReadonlyArray<SessionTag>): string | null =>
	tags.length > 0 ? tags.join(",") : null

/**
 * The selection after a checkbox change. A newly ticked tier drops any other tier,
 * because every session has exactly one and two tiers together match nothing.
 */
export function nextTagSelection(
	previous: ReadonlyArray<SessionTag>,
	values: ReadonlyArray<string>,
): Array<SessionTag> {
	const next = values.flatMap((value) => {
		const tag = asSessionTag(value)
		return tag === undefined ? [] : [tag]
	})
	const addedTier = next.find((tag) => isQualityTier(tag) && !previous.includes(tag))
	return addedTier === undefined ? next : next.filter((tag) => !isQualityTier(tag) || tag === addedTier)
}

/** The quality tier worth flagging on a row: everything but `engaged`. */
export const noiseTierOf = (tags: ReadonlyArray<SessionTag>): SessionTag | undefined =>
	tags.find((tag) => tag !== "engaged" && isQualityTier(tag))

/** A list row's tags, from the columns `sessionReplaysListQuery` returns (the domain's `sessionTagsOf`). */
export function sessionTagsOf(
	row: Pick<SessionReplaysListOutput, "quality" | "userId"> & { readonly visitorIsNew: number | string },
): Array<SessionTag> {
	const tags: Array<SessionTag> = []
	const quality = SESSION_QUALITY_TAGS.find((tag) => tag === row.quality)
	if (quality !== undefined) tags.push(quality)
	if (row.userId !== "") tags.push("signed_in")
	if (Number(row.visitorIsNew) === 1) tags.push("new_visitor")
	return tags
}
