// Home — the landing view, and the only page that reads across every signal.
//
// Deliberately not a new query surface. Every block is a tab's own hook called
// with Home's range, so each number is the number that tab reports and clicking
// it opens a warm cache rather than a spinner. Two queries are Home's own
// (`use-local-home.ts`), both because no tab already asks for them: the
// org-wide overview timeseries and the session count.
//
// The layout answers, top to bottom: how much is happening, is it healthy
// (KPIs), what has it looked like across the range (chart), which services
// (table), what is broken (errors), and who was here (sessions).

import type { ReactNode } from "react"
import { useMemo } from "react"
import {
	CircleWarningIcon,
	ComputerIcon,
	DatabaseIcon,
	EyeIcon,
	GaugeIcon,
	MobileIcon,
	NetworkNodesIcon,
} from "@maple/ui/components/icons"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { LatencyValue } from "@maple/ui/components/latency-value"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { QueryBuilderLineChart } from "@maple/ui/components/charts/line/query-builder-line-chart"
import { formatDuration, formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { formatSessionDuration, hostFromUrl, isMobileDevice } from "@maple/ui/lib/replay-format"
import { latencyToneClass } from "@maple/ui/lib/latency-tone"
import { cn } from "@maple/ui/lib/utils"
import { useLocalErrorsByType, useLocalErrorsSummary } from "../hooks/use-local-errors"
import { useLocalOverviewTimeseries, useLocalSessionsSummary } from "../hooks/use-local-home"
import { useLocalServiceCatalog } from "../hooks/use-local-service-catalog"
import { useLocalSessions } from "../hooks/use-local-sessions"
import { lastSeenByService, overviewSeries, summarizeServices } from "../lib/home-overview"
import { DOCS_LOCAL_MODE_SEND_TELEMETRY } from "../lib/links"
import { navigate, useQueryParams } from "../lib/router"
import { HOME_DEFAULT_RANGE, formatRelativeTime } from "../lib/time"
import { ConnectHint } from "../components/connect-button"
import { RefreshButton, TimeRangeSelect, Toolbar } from "../components/toolbar"
import { ErrorState, ListSkeleton } from "../components/view-states"

/** Rows shown per list block — Home summarizes, the tab it links to enumerates. */
const SERVICE_ROWS = 8
const ERROR_ROWS = 5
const SESSION_ROWS = 5

export function HomeView() {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || HOME_DEFAULT_RANGE

	// Each of these is the exact filter object its tab builds with nothing
	// selected, down to `rootOnly: false` and `errorsOnly: false` being present
	// rather than absent — React Query hashes the key object, and an omitted
	// `false` is a different key from a present one even though it compiles to
	// the same SQL. Matching them makes Home's fetch the tab's fetch, so
	// following a tile lands on a warm cache.
	const catalog = useLocalServiceCatalog({ range })
	const errorsSummary = useLocalErrorsSummary({ rootOnly: false, range })
	const errorsByType = useLocalErrorsByType({ rootOnly: false, range })
	const sessions = useLocalSessions({ errorsOnly: false, range })
	const sessionsSummary = useLocalSessionsSummary(range)
	const timeseries = useLocalOverviewTimeseries(range)

	const entries = catalog.data?.entries ?? []
	const totals = useMemo(() => summarizeServices(entries), [entries])
	const points = timeseries.data ?? []
	const chartRows = useMemo(() => overviewSeries(points), [points])
	const lastSeen = useMemo(() => lastSeenByService(points), [points])
	const recentSessions = (sessions.data?.pages[0] ?? []).slice(0, SESSION_ROWS)
	const sessionCount = sessionsSummary.data?.sessions ?? 0
	const errorCount = errorsSummary.data?.totalErrors ?? 0

	// Carry the resolved range onto every link. Home defaults narrower than the
	// list views do (`HOME_DEFAULT_RANGE`), so without this an unset `range` would
	// silently widen to 30 days the moment a tile is clicked, and the tab would
	// disagree with the number that sent the user there.
	const open = (path: string) => navigate(path, new URLSearchParams({ range }))

	const toolbar = (
		<Toolbar>
			<span className="text-sm text-muted-foreground">Overview</span>
			<div className="flex items-center gap-4">
				<RefreshButton />
				<TimeRangeSelect value={range} onChange={(next) => setParams({ range: next })} />
			</div>
		</Toolbar>
	)

	// Nothing at all has arrived: a setup problem, not an empty filter, so the
	// answer is the OTLP endpoint rather than "widen the range".
	//
	// `totalIngestedBytes` is what makes this safe to claim. The other three are
	// span-shaped, and a Maple that has only ever received logs or metrics has no
	// services, no sessions and no errors while being perfectly well connected —
	// telling that user to go set up an exporter would be wrong.
	const nothingIngested =
		entries.length === 0 &&
		sessionCount === 0 &&
		errorCount === 0 &&
		(catalog.data?.totalIngestedBytes ?? 0) === 0

	const settling =
		catalog.isPending || errorsSummary.isPending || sessionsSummary.isPending || timeseries.isPending

	return (
		<div className="flex h-full flex-col">
			{toolbar}
			<div className="min-h-0 flex-1 overflow-auto">
				{settling ? (
					<ListSkeleton rows={8} />
				) : catalog.isError ? (
					<ErrorState
						label="the overview"
						error={catalog.error}
						onRetry={() => catalog.refetch()}
					/>
				) : nothingIngested ? (
					<NothingIngestedState />
				) : (
					<div className="space-y-6 p-4">
						<section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
							<KpiTile
								label="Spans"
								value={formatNumber(totals.spanCount)}
								hint="entry points"
								onClick={() => open("/traces")}
							/>
							<KpiTile
								label="Error rate"
								value={formatErrorRate(totals.errorRate)}
								hint={`${formatNumber(totals.errorCount)} error spans`}
								danger={totals.errorRate > 0.05}
								onClick={() => open("/errors")}
							/>
							<KpiTile
								label="p95"
								value={formatDuration(totals.p95LatencyMs)}
								hint="span-weighted"
								valueClassName={latencyToneClass(totals.p95LatencyMs, "p95")}
								onClick={() => open("/services")}
							/>
							<KpiTile
								label="Services"
								value={formatNumber(totals.serviceCount)}
								hint="reporting"
								onClick={() => open("/services")}
							/>
							<KpiTile
								label="Sessions"
								value={formatNumber(sessionCount)}
								hint="recorded"
								onClick={() => open("/sessions")}
							/>
							<KpiTile
								label="Errors"
								value={formatNumber(errorCount)}
								hint="events"
								danger={errorCount > 0}
								onClick={() => open("/errors")}
							/>
						</section>

						<Panel title="Throughput and errors" onSeeAll={() => open("/traces")}>
							{timeseries.isError ? (
								<ErrorState
									label="the overview chart"
									error={timeseries.error}
									onRetry={() => timeseries.refetch()}
								/>
							) : chartRows.length < 2 ? (
								<Hint>Not enough buckets to chart this range yet.</Hint>
							) : (
								<div className="p-3">
									<QueryBuilderLineChart
										data={chartRows}
										className="h-48 w-full"
										legend="visible"
										curveType="monotone"
										tooltip="visible"
									/>
								</div>
							)}
						</Panel>

						<Panel title="Services" onSeeAll={() => open("/services")}>
							{entries.length === 0 ? (
								<Hint>No service has reported a span in this range.</Hint>
							) : (
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Service</TableHead>
											<TableHead className="text-right">Spans</TableHead>
											<TableHead className="text-right">Error rate</TableHead>
											<TableHead className="text-right">p95</TableHead>
											<TableHead className="text-right">Last seen</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{entries.slice(0, SERVICE_ROWS).map((entry) => (
											<TableRow
												key={entry.serviceName}
												className="cursor-pointer"
												onClick={() =>
													open(`/services/${encodeURIComponent(entry.serviceName)}`)
												}
											>
												<TableCell>
													<span className="flex items-center gap-2">
														<ServiceDot serviceName={entry.serviceName} />
														<span className="truncate font-medium">
															{entry.serviceName}
														</span>
													</span>
												</TableCell>
												<TableCell className="text-right tabular-nums">
													{formatNumber(entry.spanCount)}
												</TableCell>
												<TableCell
													className={cn(
														"text-right tabular-nums",
														entry.errorRate > 0.05 && "text-destructive",
													)}
												>
													{formatErrorRate(entry.errorRate)}
												</TableCell>
												<TableCell className="text-right">
													<LatencyValue ms={entry.p95LatencyMs} scale="p95" />
												</TableCell>
												<TableCell className="text-right text-xs text-muted-foreground">
													{formatRelativeTime(lastSeen.get(entry.serviceName))}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							)}
						</Panel>

						<div className="grid gap-6 lg:grid-cols-2">
							<Panel title="Recent errors" onSeeAll={() => open("/errors")}>
								{errorsByType.isError ? (
									<ErrorState
										label="errors"
										error={errorsByType.error}
										onRetry={() => errorsByType.refetch()}
									/>
								) : errorsByType.isPending ? (
									<ListSkeleton rows={ERROR_ROWS} />
								) : (errorsByType.data ?? []).length === 0 ? (
									<Hint>Nothing has failed in this range.</Hint>
								) : (
									<ul className="divide-y">
										{(errorsByType.data ?? []).slice(0, ERROR_ROWS).map((row) => (
											<li key={row.fingerprintHash}>
												<button
													type="button"
													onClick={() => open("/errors")}
													className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
												>
													<CircleWarningIcon className="size-4 shrink-0 text-destructive" />
													<span className="min-w-0 flex-1">
														<span className="block truncate text-sm font-medium">
															{row.errorLabel || "Unknown Error"}
														</span>
														{row.sampleMessage ? (
															<span className="block truncate font-mono text-xs text-muted-foreground">
																{row.sampleMessage}
															</span>
														) : null}
													</span>
													<span className="shrink-0 text-right">
														<span className="block text-sm font-semibold tabular-nums text-destructive">
															{formatNumber(row.count)}
														</span>
														<span className="block text-[10px] text-muted-foreground">
															{formatRelativeTime(row.lastSeen)}
														</span>
													</span>
												</button>
											</li>
										))}
									</ul>
								)}
							</Panel>

							<Panel title="Recent sessions" onSeeAll={() => open("/sessions")}>
								{sessions.isError ? (
									<ErrorState
										label="sessions"
										error={sessions.error}
										onRetry={() => sessions.refetch()}
									/>
								) : sessions.isPending ? (
									<ListSkeleton rows={SESSION_ROWS} />
								) : recentSessions.length === 0 ? (
									<Hint>No browser session has been recorded in this range.</Hint>
								) : (
									<ul className="divide-y">
										{recentSessions.map((session) => {
											const DeviceIcon = isMobileDevice(session.deviceType)
												? MobileIcon
												: ComputerIcon
											return (
												<li key={session.sessionId}>
													<button
														type="button"
														onClick={() =>
															open(
																`/sessions/${encodeURIComponent(session.sessionId)}`,
															)
														}
														className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
													>
														<DeviceIcon className="size-4 shrink-0 text-muted-foreground" />
														<span className="min-w-0 flex-1">
															<span className="block truncate text-sm font-medium">
																{session.browserName || "Unknown browser"}
																{session.deviceType
																	? ` · ${session.deviceType}`
																	: ""}
															</span>
															<span className="block truncate text-xs text-muted-foreground">
																{session.urlInitial
																	? hostFromUrl(session.urlInitial)
																	: session.sessionId}
															</span>
														</span>
														<span className="shrink-0 text-right">
															<span className="block text-xs tabular-nums">
																{formatSessionDuration(session.durationMs)}
															</span>
															<span className="block text-[10px] text-muted-foreground">
																{formatNumber(session.clickCount)} clicks
																{session.errorCount > 0 ? (
																	<span className="text-destructive">
																		{" "}
																		· {formatNumber(
																			session.errorCount,
																		)}{" "}
																		errors
																	</span>
																) : null}
															</span>
															<span className="block text-[10px] text-muted-foreground">
																{formatRelativeTime(session.startTime)}
															</span>
														</span>
													</button>
												</li>
											)
										})}
									</ul>
								)}
							</Panel>
						</div>
					</div>
				)}
			</div>
		</div>
	)
}

/**
 * A KPI tile. Every one is a link: the tile states a number and the tab it
 * opens is where that number came from, so there is never a figure on this page
 * whose derivation is a dead end.
 */
function KpiTile({
	label,
	value,
	hint,
	danger,
	valueClassName,
	onClick,
}: {
	label: string
	value: string
	hint: string
	danger?: boolean
	/** Applied after `danger`, so it wins — carries the latency magnitude ramp. */
	valueClassName?: string
	onClick: () => void
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="rounded-md border bg-card px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
				{label}
			</div>
			<div
				className={cn(
					"text-lg font-semibold tabular-nums",
					danger && "text-destructive",
					valueClassName,
				)}
			>
				{value}
			</div>
			<div className="truncate text-[10px] text-muted-foreground">{hint}</div>
		</button>
	)
}

function Panel({ title, onSeeAll, children }: { title: string; onSeeAll: () => void; children: ReactNode }) {
	return (
		<section className="space-y-2">
			<div className="flex items-center justify-between">
				<h3 className="text-sm font-medium">{title}</h3>
				<button
					type="button"
					onClick={onSeeAll}
					className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground hover:no-underline"
				>
					View all
				</button>
			</div>
			<div className="overflow-hidden rounded-md border bg-card">{children}</div>
		</section>
	)
}

function Hint({ children }: { children: ReactNode }) {
	return <p className="px-4 py-6 text-center text-sm text-muted-foreground">{children}</p>
}

/**
 * Shown when the binary is reachable but has never been sent anything. Distinct
 * from `DisconnectedState` (which answers "start Maple") and from a filtered
 * empty list (which answers "widen the range") — the only thing missing here is
 * an exporter pointed at the endpoint, so that endpoint is the whole screen.
 */
function NothingIngestedState() {
	return (
		<Empty className="h-full">
			<EmptyMedia variant="icon">
				<GaugeIcon className="text-muted-foreground" />
			</EmptyMedia>
			<EmptyHeader>
				<EmptyTitle>Nothing ingested yet</EmptyTitle>
				<EmptyDescription>
					Point an OpenTelemetry SDK at your local Maple and this page fills in — traces, logs,
					metrics and browser sessions all arrive on the same endpoint.
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent className="w-full max-w-md items-stretch gap-3 text-left">
				<ConnectHint />
				<div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
					<span className="flex items-center gap-3">
						<span className="flex items-center gap-1.5">
							<NetworkNodesIcon size={12} /> Traces
						</span>
						<span className="flex items-center gap-1.5">
							<DatabaseIcon size={12} /> Services
						</span>
						<span className="flex items-center gap-1.5">
							<EyeIcon size={12} /> Sessions
						</span>
					</span>
					<a
						href={DOCS_LOCAL_MODE_SEND_TELEMETRY}
						target="_blank"
						rel="noopener noreferrer"
						className="underline underline-offset-2 hover:no-underline"
					>
						OTLP setup docs
					</a>
				</div>
			</EmptyContent>
		</Empty>
	)
}
