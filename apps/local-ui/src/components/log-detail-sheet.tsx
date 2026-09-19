// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
// Intentionally divergent from the web app's `@/components/logs/log-detail-sheet`:
// that one is wired to effect-atom (trace timeline, correlated logs) and a wider
// sub-component family local mode doesn't have. The shareable pieces (AttributesSection,
// SeverityBadge, severity/format libs) already come from @maple/ui.

import { useMemo, useState } from "react"
import { Sheet, SheetContent, SheetTitle } from "@maple/ui/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@maple/ui/components/ui/tabs"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { SeverityBadge } from "@maple/ui/components/logs/severity-badge"
import {
	CircleInfoIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	ClockIcon,
	CodeIcon,
	PulseIcon,
	XmarkIcon,
} from "@maple/ui/components/icons"
import { CopyableValue, AttributesSection, ResourceAttributesSection } from "@maple/ui/components/attributes"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { cn } from "@maple/ui/lib/utils"
import type { LocalLog } from "../lib/log-shape"
import { navigate } from "../lib/router"
import { ErrorSection } from "@maple/ui/components/error-section"
import { SearchInput } from "@maple/ui/components/ui/search-input"
import { CodeBlock } from "./code-block"
import { collectCodeAttributes, detectLanguage } from "../lib/code-block"

interface LogDetailSheetProps {
	log: LocalLog | null
	open: boolean
	onOpenChange: (open: boolean) => void
}

/**
 * Slide-out drawer for a single log, mirroring the web app's `LogDetailSheet`:
 * a tone-tinted hero, a meta strip with trace/span links, an error banner for
 * ERROR/FATAL, and Attributes / Trace / Raw tabs. The list row already carries
 * the full (decoded) attribute maps, so no extra fetch is needed.
 */
export function LogDetailSheet({ log, open, onOpenChange }: LogDetailSheetProps) {
	if (!log) return null

	const sev = log.severityText.toUpperCase()
	const showErrorBanner = sev === "ERROR" || sev === "FATAL"
	// Identity used to remount the attributes panel (resets its search) per log.
	const logKey = `${log.timestamp}-${log.spanId}-${log.body.slice(0, 24)}`

	const openTrace = () => {
		if (!log.traceId) return
		navigate(`/traces/${encodeURIComponent(log.traceId)}`)
		onOpenChange(false)
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="flex flex-col p-0 sm:max-w-2xl" showCloseButton={false}>
				<SheetTitle className="sr-only">Log: {log.body.slice(0, 80)}</SheetTitle>

				<LogHeroHeader log={log} onClose={() => onOpenChange(false)} />
				<LogMetaStrip log={log} onOpenTrace={openTrace} />
				{showErrorBanner && <LogErrorBanner log={log} />}

				<Tabs defaultValue="attributes" className="flex min-h-0 flex-1 flex-col">
					<TabsList variant="underline" className="shrink-0 px-4">
						<TabsTrigger value="attributes">
							<CircleInfoIcon size={14} /> Attributes
						</TabsTrigger>
						{log.traceId && (
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
								<LogAttributesPanel key={logKey} log={log} />
							</div>
						</ScrollArea>
					</TabsContent>

					{log.traceId && (
						<TabsContent value="trace" className="mt-0 min-h-0 flex-1">
							<ScrollArea className="h-full">
								<div className="p-3">
									<LogTracePanel log={log} onOpenTrace={openTrace} />
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

const HERO_TONE: Record<string, string> = {
	TRACE: "bg-severity-trace/5 border-severity-trace/20",
	DEBUG: "bg-severity-debug/5 border-severity-debug/20",
	INFO: "bg-severity-info/5 border-severity-info/20",
	WARN: "bg-severity-warn/5 border-severity-warn/20",
	WARNING: "bg-severity-warn/5 border-severity-warn/20",
	ERROR: "bg-severity-error/5 border-severity-error/20",
	FATAL: "bg-severity-fatal/5 border-severity-fatal/20",
} satisfies Record<string, string>

const BODY_LINE_THRESHOLD = 280

function LogHeroHeader({ log, onClose }: { log: LocalLog; onClose: () => void }) {
	const [expanded, setExpanded] = useState(false)
	const tone = HERO_TONE[log.severityText.toUpperCase()] ?? "border-border"
	const body = log.body ?? ""

	// A log body is a sentence far more often than it is a document. Only one
	// that detects as *something* — a JSON envelope, a statement, a markup
	// fragment — gets the code block; a sentence in a bordered block with its own
	// toolbar reads worse than a sentence, and the block brings its own fold and
	// its own copy control, so the clamp below would be a second one of each.
	const language = useMemo(() => detectLanguage(body), [body])
	const structured = language !== "text"
	const isLong = body.length > BODY_LINE_THRESHOLD || body.includes("\n")

	return (
		<div className={cn("shrink-0 border-b px-4 py-3", tone)}>
			<div className="flex items-center gap-2">
				<SeverityBadge severity={log.severityText} />
				<Badge variant="outline" className="font-mono text-[10px]">
					<CopyableValue value={log.serviceName}>{log.serviceName}</CopyableValue>
				</Badge>
				<Button variant="ghost" size="icon" className="ml-auto shrink-0" onClick={onClose}>
					<XmarkIcon size={16} />
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
						<CopyableValue value={body}>
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

function LogMetaStrip({ log, onOpenTrace }: { log: LocalLog; onOpenTrace: () => void }) {
	return (
		<div className="flex shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b px-4 py-1.5 text-xs">
			<div className="flex shrink-0 items-center gap-1.5">
				<ClockIcon size={12} className="text-muted-foreground" />
				<span className="font-mono">
					<CopyableValue value={log.timestamp}>{log.timestamp}</CopyableValue>
				</span>
			</div>

			{log.traceId && (
				<button
					type="button"
					onClick={onOpenTrace}
					className="inline-flex shrink-0 items-center gap-1 rounded border border-primary/20 bg-primary/5 px-1.5 py-0.5 font-mono text-[11px] text-primary transition-colors hover:bg-primary/10"
					title={`View trace ${log.traceId}`}
				>
					<PulseIcon size={10} />
					trace:{log.traceId.slice(0, 8)}
				</button>
			)}

			{log.spanId && (
				<span className="shrink-0 font-mono text-[11px] text-muted-foreground">
					<CopyableValue value={log.spanId}>span:{log.spanId.slice(0, 8)}</CopyableValue>
				</span>
			)}

			<div className="ml-auto flex shrink-0 items-center gap-0.5">
				<CopyButton value={() => buildLogJsonPayload(log)} label="Log JSON" iconSize={13} tooltip />
			</div>
		</div>
	)
}

function getErrorMessage(log: LocalLog): string {
	return log.logAttributes["exception.message"] ?? log.logAttributes["error.message"] ?? log.body ?? ""
}

function LogErrorBanner({ log }: { log: LocalLog }) {
	const message = getErrorMessage(log)
	if (!message) return null

	return (
		<ErrorSection
			message={message}
			title={log.severityText.toUpperCase() === "FATAL" ? "Fatal" : "Error"}
			badge={log.logAttributes["exception.type"] ?? log.logAttributes["error.type"]}
			prompt={{ serviceName: log.serviceName, attributes: log.logAttributes }}
		/>
	)
}

function LogAttributesPanel({ log }: { log: LocalLog }) {
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

			<AttributesSection
				attributes={tableAttributes}
				title="Log Attributes"
				searchQuery={attrSearch}
				groupByNamespace
			/>
			<ResourceAttributesSection
				attributes={log.resourceAttributes}
				searchQuery={attrSearch}
				groupByNamespace
			/>
		</div>
	)
}

function LogTracePanel({ log, onOpenTrace }: { log: LocalLog; onOpenTrace: () => void }) {
	return (
		<div className="space-y-3">
			<div className="rounded-md border p-2 text-xs space-y-1">
				<div className="flex justify-between gap-3">
					<span className="text-muted-foreground">Trace ID</span>
					<span className="truncate font-mono">
						<CopyableValue value={log.traceId}>{log.traceId}</CopyableValue>
					</span>
				</div>
				{log.spanId && (
					<div className="flex justify-between gap-3">
						<span className="text-muted-foreground">Span ID</span>
						<span className="truncate font-mono">
							<CopyableValue value={log.spanId}>{log.spanId}</CopyableValue>
						</span>
					</div>
				)}
			</div>
			<Button variant="outline" size="sm" className="w-full gap-1.5" onClick={onOpenTrace}>
				<PulseIcon size={14} />
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
