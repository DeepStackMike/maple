// The Analytics tab's funnel panel: pick 2–5 events in order and a conversion
// window, get the per-step counts, conversion and drop-off.
//
// The definition (steps + window) is URL state owned by the view; this
// component is the picker over it plus the chart and table of the result.

import { useMemo } from "react"
import type { UseQueryResult } from "@tanstack/react-query"
import { PlusIcon, XmarkIcon } from "@maple/ui/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@maple/ui/components/ui/native-select"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { QueryBuilderFunnelChart } from "@maple/ui/components/charts/funnel/query-builder-funnel-chart"
import { useLocalProductEventFunnel, type ProductEventName } from "../hooks/use-local-product-events"
import {
	CONVERSION_WINDOWS,
	FUNNEL_MAX_STEPS,
	FUNNEL_MIN_STEPS,
	formatPercent,
	isRunnableFunnel,
	toFunnelStages,
	type ConversionWindow,
} from "../lib/product-analytics"
import { ErrorState } from "./view-states"

interface FunnelPanelProps {
	names: UseQueryResult<ReadonlyArray<ProductEventName>, Error>
	range: string
	/** The picker's slots, in order. Always between MIN and MAX; unset slots are `""`. */
	steps: ReadonlyArray<string>
	onStepsChange: (next: ReadonlyArray<string>) => void
	conversionWindow: ConversionWindow
	onConversionWindowChange: (key: string) => void
}

export function FunnelPanel({
	names,
	range,
	steps,
	onStepsChange,
	conversionWindow,
	onConversionWindowChange,
}: FunnelPanelProps) {
	const options = names.data ?? []
	const runnable = isRunnableFunnel(steps)
	const funnel = useLocalProductEventFunnel(steps, conversionWindow.seconds, range)

	const stages = useMemo(
		() => (runnable ? toFunnelStages(steps, funnel.data ?? []) : []),
		[runnable, steps, funnel.data],
	)

	// The chart folds stages by name, so a funnel that repeats an event would
	// otherwise collapse two steps into one bar. The step number is what makes
	// each stage distinct, and it is worth showing regardless.
	const chartData = useMemo(
		() => stages.map((stage) => ({ name: `${stage.step}. ${stage.name}`, value: stage.count })),
		[stages],
	)

	const setStep = (index: number, value: string) =>
		onStepsChange(steps.map((step, i) => (i === index ? value : step)))

	const removeStep = (index: number) => onStepsChange(steps.filter((_, i) => i !== index))

	return (
		<section className="space-y-2">
			<div className="flex items-baseline justify-between gap-3">
				<h3 className="text-sm font-medium">Funnel</h3>
				<span className="text-xs text-muted-foreground">
					Counted by session, {conversionWindow.label} of the first step
				</span>
			</div>

			<div className="space-y-2 rounded-md border bg-muted/20 p-3">
				<div className="flex flex-wrap items-center gap-2">
					{steps.map((step, index) => (
						<span key={index} className="flex items-center gap-1">
							<span className="text-xs text-muted-foreground">{index + 1}.</span>
							<NativeSelect
								size="sm"
								aria-label={`Funnel step ${index + 1}`}
								value={step}
								onChange={(e) => setStep(index, e.target.value)}
								disabled={options.length === 0}
							>
								<NativeSelectOption value="">
									{options.length === 0
										? names.isPending
											? "Loading…"
											: "No events"
										: "Pick an event…"}
								</NativeSelectOption>
								{options.map((option) => (
									<NativeSelectOption
										key={`${option.eventName}\x00${option.kind}`}
										value={option.eventName}
									>
										{option.eventName}
									</NativeSelectOption>
								))}
								{/* A step carried in from a URL stays selected even if the
								    event has not fired in the current range. */}
								{step !== "" && !options.some((option) => option.eventName === step) ? (
									<NativeSelectOption value={step}>{step}</NativeSelectOption>
								) : null}
							</NativeSelect>
							{steps.length > FUNNEL_MIN_STEPS ? (
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={`Remove step ${index + 1}`}
									onClick={() => removeStep(index)}
								>
									<XmarkIcon size={12} />
								</Button>
							) : null}
						</span>
					))}

					{steps.length < FUNNEL_MAX_STEPS ? (
						<Button
							variant="outline"
							size="sm"
							className="gap-1"
							onClick={() => onStepsChange([...steps, ""])}
						>
							<PlusIcon size={12} />
							Step
						</Button>
					) : null}

					<label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
						Converts
						<NativeSelect
							size="sm"
							value={conversionWindow.key}
							onChange={(e) => onConversionWindowChange(e.target.value)}
						>
							{CONVERSION_WINDOWS.map((option) => (
								<NativeSelectOption key={option.key} value={option.key}>
									{option.label}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</label>
				</div>
			</div>

			{!runnable ? (
				<p className="text-xs text-muted-foreground">
					Pick {FUNNEL_MIN_STEPS} or more events, in the order a user performs them.
				</p>
			) : funnel.isPending ? (
				<div className="flex h-64 items-center justify-center rounded-md border">
					<Spinner />
				</div>
			) : funnel.isError ? (
				<ErrorState label="funnel" error={funnel.error} onRetry={() => funnel.refetch()} />
			) : (
				<div className="space-y-2">
					<div className="rounded-md border p-3">
						<QueryBuilderFunnelChart data={chartData} className="h-64" showStepPercent />
					</div>
					<div className="rounded-md border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Step</TableHead>
									<TableHead className="text-right">Sessions</TableHead>
									<TableHead className="text-right">Of step 1</TableHead>
									<TableHead className="text-right">From previous</TableHead>
									<TableHead className="text-right">Drop-off</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{stages.map((stage) => (
									<TableRow key={stage.step}>
										<TableCell className="font-mono text-xs">
											{stage.step}. {stage.name}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{stage.count.toLocaleString()}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatPercent(stage.conversion)}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{stage.stepConversion === null
												? "—"
												: formatPercent(stage.stepConversion)}
										</TableCell>
										<TableCell className="text-right tabular-nums text-muted-foreground">
											{stage.dropOff === null ? "—" : stage.dropOff.toLocaleString()}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				</div>
			)}
		</section>
	)
}
