// The logs just before and after one log, for the detail drawer's Context tab.
// Ported from the hosted `log-context-panel.tsx`, reading through react-query
// and the local chDB store instead of effect-atom.

import { useCallback, useState } from "react"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { severityLabel } from "@maple/ui/components/logs/severity-badge"
import { stripAnsi } from "@maple/ui/components/logs/strip-ansi"
import { getSeverityColor } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import { useLocalLogContext } from "../hooks/use-local-logs"
import { contextKey, instanceAttribute, mergeLogContext } from "../lib/log-context"
import type { LocalLog } from "../lib/log-shape"
import { formatUtcTitle } from "../lib/time"
import { LogTime } from "./log-time"
import { ErrorState, ListSkeleton } from "./view-states"
import { failedWithoutData } from "../lib/query"

type ContextScope = "service" | "instance"

const QUIET_SEVERITIES = new Set(["DEBUG", "TRACE"])
const ROW_CLASS = "flex w-full items-center gap-2 px-2 py-1"

/**
 * The 25 logs before and after one log from the same service, or from the
 * same instance when the log names one (toggleable), within an hour of it.
 * The selected row is centred; clicking a neighbour opens it.
 */
export function LogContextPanel({
	log,
	onLogSelect,
}: {
	log: LocalLog
	onLogSelect: (log: LocalLog) => void
}) {
	const instance = instanceAttribute(log)
	const [preferredScope, setPreferredScope] = useState<ContextScope>("instance")
	const scope: ContextScope = instance ? preferredScope : "service"
	const scopedInstance = scope === "instance" ? instance : undefined
	const context = useLocalLogContext(log, scopedInstance)

	return (
		<div className="flex h-full min-h-0 flex-col gap-1.5">
			<div className="flex shrink-0 items-center gap-2">
				<h4 className="min-w-0 truncate text-xs font-medium text-muted-foreground">
					Surrounding logs
					<span className="ml-1 font-normal text-muted-foreground/60">
						{scopedInstance ? `${scopedInstance.key}=${scopedInstance.value}` : log.serviceName}
					</span>
				</h4>
				{instance && (
					<ToggleGroup
						variant="outline"
						size="xs"
						aria-label="Context scope"
						className="ml-auto shrink-0"
						value={[scope]}
						onValueChange={(values) => {
							const next = values.find((value) => value !== scope)
							if (next === "service" || next === "instance") setPreferredScope(next)
						}}
					>
						<ToggleGroupItem value="instance">Instance</ToggleGroupItem>
						<ToggleGroupItem value="service">Service</ToggleGroupItem>
					</ToggleGroup>
				)}
			</div>
			{context.isPending ? (
				<ListSkeleton rows={8} variant="table" />
			) : failedWithoutData(context) ? (
				<ErrorState
					label="surrounding logs"
					error={context.error}
					onRetry={() => void context.refetch()}
				/>
			) : context.data === null ? (
				<EmptyMessage>This log has no readable timestamp</EmptyMessage>
			) : (
				<ContextList
					log={log}
					rows={mergeLogContext(log, context.data.before, context.data.after)}
					onLogSelect={onLogSelect}
				/>
			)}
		</div>
	)
}

function ContextList({
	log,
	rows,
	onLogSelect,
}: {
	log: LocalLog
	rows: ReadonlyArray<LocalLog>
	onLogSelect: (log: LocalLog) => void
}) {
	const selectedKey = contextKey(log)
	// Centre the selected row inside this list only; `scrollIntoView` would also scroll the drawer.
	const centerSelected = useCallback((node: HTMLLIElement | null) => {
		const list = node?.parentElement
		if (!node || !list) return
		list.scrollTop = node.offsetTop - (list.clientHeight - node.offsetHeight) / 2
	}, [])

	if (rows.length <= 1) return <EmptyMessage>No other logs around this one</EmptyMessage>

	return (
		<ul
			aria-label="Surrounding logs"
			className="relative max-h-[60vh] min-h-0 flex-1 overflow-y-auto rounded-md border"
		>
			{rows.map((row) => {
				const key = contextKey(row)
				const isCurrent = key === selectedKey
				const severity = severityLabel(row.severityText, row.severityNumber).toUpperCase()
				const color = getSeverityColor(severity)
				const cells = (
					<>
						<span
							className="w-[92px] shrink-0 truncate tabular-nums text-foreground/75"
							title={formatUtcTitle(row.timestamp)}
						>
							<LogTime timestamp={row.timestamp} />
						</span>
						<span
							className="w-11 shrink-0 truncate text-3xs font-semibold uppercase leading-4 tracking-wide tabular-nums"
							style={{ color }}
						>
							{severity}
						</span>
						<span
							className={cn(
								"min-w-0 flex-1 truncate",
								isCurrent
									? "text-foreground"
									: QUIET_SEVERITIES.has(severity)
										? "text-muted-foreground"
										: "text-foreground/85",
							)}
						>
							{stripAnsi(row.body).split("\n", 1)[0]}
						</span>
					</>
				)
				return (
					<li
						key={key}
						ref={isCurrent ? centerSelected : undefined}
						aria-current={isCurrent || undefined}
						style={{ borderLeftColor: color }}
						className="border-b border-l-2 border-b-border/70 font-mono text-xs last:border-b-0"
					>
						{isCurrent ? (
							<div className={cn(ROW_CLASS, "bg-primary/8")}>{cells}</div>
						) : (
							<button
								type="button"
								className={cn(
									ROW_CLASS,
									"cursor-pointer text-left hover:bg-muted/50 focus-visible:bg-muted/70 focus-visible:outline-none",
								)}
								onClick={() => onLogSelect(row)}
							>
								{cells}
							</button>
						)}
					</li>
				)
			})}
		</ul>
	)
}
