// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
// Intentionally divergent from the web app's `@/components/logs/log-detail-sheet`:
// that one is wired to effect-atom (trace timeline, correlated logs) and a wider
// sub-component family local mode doesn't have. The shareable pieces (AttributesSection,
// SeverityBadge, severity/format libs) already come from @maple/ui.

import { useMemo, useState, type CSSProperties } from "react"
import { Sheet, SheetContent, SheetTitle } from "@maple/ui/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@maple/ui/components/ui/tabs"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { KeyValue, KeyValueList } from "@maple/ui/components/ui/key-value"
import { shortId } from "@maple/ui/lib/ids"
import { SeverityBadge, severityLabel } from "@maple/ui/components/logs/severity-badge"
import { stripAnsi } from "@maple/ui/components/logs/strip-ansi"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { SEVERITY_COLORS } from "@maple/ui/lib/severity"
import {
	CircleInfoIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	ClockIcon,
	CodeIcon,
	LayersIcon,
	LinkIcon,
	PulseIcon,
	XmarkIcon,
} from "@maple/ui/components/icons"
import {
	AttributesProvider,
	CopyableValue,
	AttributesSection,
	ResourceAttributesSection,
	type AttributesConfig,
} from "@maple/ui/components/attributes"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { cn } from "@maple/ui/lib/utils"
import { logKey, type LocalLog } from "../lib/log-shape"
import { hrefFor } from "../lib/router"
import { formatLocalDateTime, formatUtcTitle } from "../lib/time"
import { LogErrorBanner } from "@maple/ui/components/logs/log-error-banner"
import { SearchInput } from "@maple/ui/components/ui/search-input"
import { CodeBlock } from "./code-block"
import { collectCodeAttributes, detectLanguage } from "../lib/code-block"
import type { LogAttributeFilter, LogAttributeSource } from "../lib/log-attribute-filters"
import { logPermalink } from "../lib/log-context"
import { LogContextPanel } from "./log-context-panel"

interface LogDetailSheetProps {
	log: LocalLog | null
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Gives every attribute row Filter / Exclude actions. Omit for read-only. */
	onAttributeFilter?: (filter: LogAttributeFilter) => void
	/** Opens a neighbour from the Context tab. Omit and the tab is hidden. */
	onSelectLog?: (log: LocalLog) => void
}

/**
 * Slide-out drawer for a single log, mirroring the web app's `LogDetailSheet`:
 * a tone-tinted hero, a meta strip with trace/span links, an error banner for
 * ERROR/FATAL, and Attributes / Trace / Raw tabs. The list row already carries
 * the full (decoded) attribute maps, so no extra fetch is needed.
 */
export function LogDetailSheet({
	log,
	open,
	onOpenChange,
	onAttributeFilter,
	onSelectLog,
}: LogDetailSheetProps) {
	if (!log) return null

	const sev = severityLabel(log.severityText, log.severityNumber).toUpperCase()
	const showErrorBanner = sev === "ERROR" || sev === "FATAL" || sev === "CRITICAL"
	// Identity used to remount the attributes panel (resets its search) per log.
	const identity = logKey(log)
	const traceHref = log.traceId
		? hrefFor(
				`/traces/${encodeURIComponent(log.traceId)}`,
				new URLSearchParams(log.spanId ? { spanId: log.spanId } : {}),
			)
		: undefined
	const onOpenTrace = () => onOpenChange(false)

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="flex flex-col p-0 sm:max-w-2xl" showCloseButton={false}>
				<SheetTitle className="sr-only">Log: {log.body.slice(0, 80)}</SheetTitle>

				<LogHeroHeader log={log} onClose={() => onOpenChange(false)} />
				<LogMetaStrip log={log} traceHref={traceHref} onOpenTrace={onOpenTrace} />
				{showErrorBanner && <LogErrorBanner log={log} />}

				<Tabs defaultValue="attributes" className="flex min-h-0 flex-1 flex-col">
					<TabsList variant="underline" className="shrink-0 px-4">
						<TabsTrigger value="attributes">
							<CircleInfoIcon size={14} /> Attributes
						</TabsTrigger>
						{onSelectLog && (
							<TabsTrigger value="context">
								<LayersIcon size={14} /> Context
							</TabsTrigger>
						)}
						{traceHref && (
							<TabsTrigger value="trace">
								<PulseIcon size={14} /> Trace
							</TabsTrigger>
						)}
						<TabsTrigger value="raw">
							<CodeIcon size={14} /> Raw
						</TabsTrigger>
					</TabsList>

					<TabsContent value="attributes" className="mt-0 min-h-0 flex-1">
						<ScrollArea className="h-full">
							<div className="p-3">
								<LogAttributesPanel
									key={identity}
									log={log}
									onAttributeFilter={onAttributeFilter}
								/>
							</div>
						</ScrollArea>
					</TabsContent>

					{onSelectLog && (
						<TabsContent value="context" className="mt-0 min-h-0 flex-1">
							<div className="h-full p-3">
								<LogContextPanel key={identity} log={log} onLogSelect={onSelectLog} />
							</div>
						</TabsContent>
					)}

					{traceHref && (
						<TabsContent value="trace" className="mt-0 min-h-0 flex-1">
							<ScrollArea className="h-full">
								<div className="p-3">
									<LogTracePanel
										log={log}
										traceHref={traceHref}
										onOpenTrace={onOpenTrace}
									/>
								</div>
							</ScrollArea>
						</TabsContent>
					)}

					<TabsContent value="raw" className="mt-0 min-h-0 flex-1">
						<ScrollArea className="h-full">
							<div className="p-3">
								<LogRawPanel log={log} />
							</div>
						</ScrollArea>
					</TabsContent>
				</Tabs>
			</SheetContent>
		</Sheet>
	)
}

/** A faint wash of the severity colour behind the hero; unknown levels keep the plain border. */
function heroToneStyle(severity: string): CSSProperties | undefined {
	const color = SEVERITY_COLORS[severity.toUpperCase()]
	if (color === undefined) return undefined
	return {
		backgroundColor: `color-mix(in oklch, ${color} 5%, transparent)`,
		borderColor: `color-mix(in oklch, ${color} 20%, transparent)`,
	}
}

const BODY_LINE_THRESHOLD = 280

function LogHeroHeader({ log, onClose }: { log: LocalLog; onClose: () => void }) {
	const [expanded, setExpanded] = useState(false)
	const severity = severityLabel(log.severityText, log.severityNumber)
	// ANSI color codes are stripped for display only; copy and Raw keep the original.
	const body = useMemo(() => stripAnsi(log.body ?? ""), [log.body])

	// A log body is a sentence far more often than it is a document. Only one
	// that detects as *something* — a JSON envelope, a statement, a markup
	// fragment — gets the code block; a sentence in a bordered block with its own
	// toolbar reads worse than a sentence, and the block brings its own fold and
	// its own copy control, so the clamp below would be a second one of each.
	const language = useMemo(() => detectLanguage(body), [body])
	const structured = language !== "text"
	const isLong = body.length > BODY_LINE_THRESHOLD || body.includes("\n")

	return (
		<div className="shrink-0 border-b px-4 py-3" style={heroToneStyle(severity)}>
			<div className="flex items-center gap-2">
				<SeverityBadge severity={log.severityText} severityNumber={log.severityNumber} />
				<Badge variant="outline" size="xs" mono>
					<ServiceDot serviceName={log.serviceName} size="sm" />
					<CopyableValue value={log.serviceName}>{log.serviceName}</CopyableValue>
				</Badge>
				<Button
					variant="ghost"
					size="icon"
					className="ml-auto shrink-0"
					aria-label="Close log details"
					onClick={onClose}
				>
					<XmarkIcon />
				</Button>
			</div>

			<div className="mt-3">
				{structured ? (
					<CodeBlock
						value={body}
						language={language}
						label="body"
						copyLabel="log body"
						collapseAfter={8}
					/>
				) : (
					<>
						{/* ANSI codes are stripped for display; the copy is the body as sent. */}
						<CopyableValue value={log.body ?? ""}>
							<p
								className={cn(
									"font-mono text-sm leading-relaxed whitespace-pre-wrap break-words",
									isLong && !expanded && "line-clamp-4",
								)}
							>
								{body}
							</p>
						</CopyableValue>
						{isLong && (
							<button
								type="button"
								onClick={() => setExpanded((v) => !v)}
								className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
							>
								{expanded ? "Show less" : "Show full message"}
								{expanded ? <ChevronUpIcon size={10} /> : <ChevronDownIcon size={10} />}
							</button>
						)}
					</>
				)}
			</div>
		</div>
	)
}

function LogMetaStrip({
	log,
	traceHref,
	onOpenTrace,
}: {
	log: LocalLog
	traceHref: string | undefined
	onOpenTrace: () => void
}) {
	return (
		<div className="flex shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b px-4 py-1.5 text-xs">
			<div className="flex shrink-0 items-center gap-1.5">
				<ClockIcon size={12} className="text-muted-foreground" />
				<span className="font-mono" title={formatUtcTitle(log.timestamp)}>
					<CopyableValue value={log.timestamp}>{formatLocalDateTime(log.timestamp)}</CopyableValue>
				</span>
			</div>

			{traceHref && (
				<a
					href={traceHref}
					onClick={onOpenTrace}
					className="inline-flex shrink-0 items-center gap-1 rounded border border-primary/20 bg-primary/5 px-1.5 py-0.5 font-mono text-[11px] text-primary transition-colors hover:bg-primary/10"
					title={`View trace ${log.traceId}`}
				>
					<PulseIcon size={10} />
					trace:{shortId(log.traceId, "trace")}
				</a>
			)}

			{log.spanId && (
				<span className="shrink-0 font-mono text-[11px] text-muted-foreground">
					<CopyableValue value={log.spanId}>span:{shortId(log.spanId, "span")}</CopyableValue>
				</span>
			)}

			<div className="ml-auto flex shrink-0 items-center gap-0.5">
				<CopyButton
					value={() => logPermalink(log)}
					label="Link to log"
					idleIcon={LinkIcon}
					iconSize={13}
					tooltip
				/>
				<CopyButton value={() => buildLogJsonPayload(log)} label="Log JSON" iconSize={13} tooltip />
			</div>
		</div>
	)
}

type FilterByAttribute = NonNullable<AttributesConfig["onFilterByAttribute"]>

/** The table's row-level filter callback, bound to the map the section shows. */
function sectionFilter(
	source: LogAttributeSource,
	onAttributeFilter: ((filter: LogAttributeFilter) => void) | undefined,
): FilterByAttribute | undefined {
	if (!onAttributeFilter) return undefined
	return ({ attrKey, value, action }) =>
		onAttributeFilter({ source, key: attrKey, value, negated: action === "exclude" })
}

function LogAttributesPanel({
	log,
	onAttributeFilter,
}: {
	log: LocalLog
	onAttributeFilter?: (filter: LogAttributeFilter) => void
}) {
	const [attrSearch, setAttrSearch] = useState("")

	const hasAttributes =
		Object.keys(log.logAttributes).length > 0 || Object.keys(log.resourceAttributes).length > 0

	// Same lift as the span panel: a document-shaped value comes out of the table
	// and gets a block of its own, because it is unreadable in a value cell.
	const payloads = useMemo(() => collectCodeAttributes(log.logAttributes), [log.logAttributes])
	const payloadKeys = new Set(payloads.map((payload) => payload.key))
	const tableAttributes = Object.fromEntries(
		Object.entries(log.logAttributes).filter(([key]) => !payloadKeys.has(key)),
	)

	// The search box filters the table; a payload block has no rows to filter, so
	// it matches on its key and its text and then shows all of itself or none.
	const query = attrSearch.toLowerCase()
	const visiblePayloads =
		query === ""
			? payloads
			: payloads.filter(
					(payload) =>
						payload.key.toLowerCase().includes(query) ||
						payload.value.toLowerCase().includes(query),
				)

	return (
		<div className="space-y-3">
			{hasAttributes && (
				<SearchInput
					value={attrSearch}
					onValueChange={setAttrSearch}
					placeholder="Search attributes..."
				/>
			)}

			{visiblePayloads.length > 0 && (
				<div className="space-y-2">
					{visiblePayloads.map((payload) => (
						<CodeBlock
							key={payload.key}
							value={payload.value}
							language={payload.language}
							label={payload.key}
							copyLabel={payload.key}
							compact
						/>
					))}
				</div>
			)}

			<AttributesProvider onFilterByAttribute={sectionFilter("log", onAttributeFilter)}>
				<AttributesSection
					attributes={tableAttributes}
					title="Log attributes"
					searchQuery={attrSearch}
					groupByNamespace
				/>
			</AttributesProvider>
			<AttributesProvider onFilterByAttribute={sectionFilter("resource", onAttributeFilter)}>
				<ResourceAttributesSection
					attributes={log.resourceAttributes}
					searchQuery={attrSearch}
					groupByNamespace
				/>
			</AttributesProvider>
		</div>
	)
}

function LogTracePanel({
	log,
	traceHref,
	onOpenTrace,
}: {
	log: LocalLog
	traceHref: string
	onOpenTrace: () => void
}) {
	return (
		<div className="space-y-3">
			<KeyValueList className="gap-1 rounded-md border p-2">
				<KeyValue label="Trace ID" mono>
					<CopyableValue value={log.traceId}>{log.traceId}</CopyableValue>
				</KeyValue>
				{log.spanId && (
					<KeyValue label="Span ID" mono>
						<CopyableValue value={log.spanId}>{log.spanId}</CopyableValue>
					</KeyValue>
				)}
			</KeyValueList>
			<Button
				variant="outline"
				size="sm"
				className="w-full gap-1.5"
				render={<a href={traceHref} onClick={onOpenTrace} />}
			>
				<PulseIcon />
				Open trace
			</Button>
		</div>
	)
}

/** Pretty-printed JSON of the full log, with a copy control. */
function buildLogJsonPayload(log: LocalLog): string {
	return JSON.stringify(
		{
			timestamp: log.timestamp,
			severityText: log.severityText,
			severityNumber: log.severityNumber,
			serviceName: log.serviceName,
			body: log.body,
			traceId: log.traceId || undefined,
			spanId: log.spanId || undefined,
			logAttributes: log.logAttributes,
			resourceAttributes: log.resourceAttributes,
		},
		null,
		2,
	)
}

function LogRawPanel({ log }: { log: LocalLog }) {
	const jsonPayload = useMemo(() => buildLogJsonPayload(log), [log])

	// Numbered here and nowhere else: this is the whole record, and a line number
	// is how you say which part of it you are talking about. An attribute payload
	// is a fragment, where the gutter is chrome.
	return (
		<CodeBlock
			value={jsonPayload}
			language="json"
			label="JSON payload"
			copyLabel="Log JSON"
			lineNumbers
			collapseAfter={40}
		/>
	)
}
