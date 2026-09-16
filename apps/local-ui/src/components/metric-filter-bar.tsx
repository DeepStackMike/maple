// The metric explorer's control bar: which dimension splits the chart into
// series, how many of them to draw, and which datapoints to consider.
//
// All three are URL state owned by the detail view — this component is the
// form over them, plus the attribute key/value discovery the form needs.

import { useState, type FormEvent } from "react"
import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@maple/ui/components/ui/native-select"
import { ActiveFilterChips } from "@maple/ui/components/filters/active-filter-chips"
import {
	useLocalMetricAttributeKeys,
	useLocalMetricAttributeValues,
	type MetricExplorerOptions,
} from "../hooks/use-local-metric-detail"
import type { MetricEntry } from "../hooks/use-local-metrics"
import { GROUP_BY_SERVICE, SERIES_LIMIT_OPTIONS, type MetricFilter } from "../lib/metric-explorer"

interface MetricFilterBarProps {
	entry: MetricEntry | null | undefined
	range: string
	options: MetricExplorerOptions
	onGroupByChange: (next: string) => void
	onSeriesLimitChange: (next: number) => void
	onFiltersChange: (next: ReadonlyArray<MetricFilter>) => void
}

export function MetricFilterBar({
	entry,
	range,
	options,
	onGroupByChange,
	onSeriesLimitChange,
	onFiltersChange,
}: MetricFilterBarProps) {
	const attributeKeys = useLocalMetricAttributeKeys(entry, range)
	const keys = attributeKeys.data ?? []
	// The draft key is unset until the user picks one, so the select falls back
	// to the first discovered key rather than resetting itself as keys load.
	const [draftKey, setDraftKey] = useState("")
	const [draftValue, setDraftValue] = useState("")
	const activeKey = draftKey || keys[0]?.name || ""
	const attributeValues = useLocalMetricAttributeValues(entry, range, activeKey || undefined)
	// An attribute key is dotted, sometimes spaced — neither belongs in the id a
	// `list=` attribute has to match.
	const valueListId = `metric-filter-values-${activeKey.replace(/[^\w-]/g, "-")}`

	const addFilter = (event: FormEvent) => {
		event.preventDefault()
		if (!activeKey) return
		onFiltersChange([...options.filters, { key: activeKey, value: draftValue }])
		setDraftValue("")
	}

	const removeFilter = (index: number) => onFiltersChange(options.filters.filter((_, i) => i !== index))

	return (
		<div className="space-y-2 rounded-md border bg-muted/20 p-3">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
				<label className="flex items-center gap-1.5 text-xs text-muted-foreground">
					Group by
					<NativeSelect
						size="sm"
						value={options.groupBy}
						onChange={(e) => onGroupByChange(e.target.value)}
						disabled={attributeKeys.isPending}
					>
						<NativeSelectOption value={GROUP_BY_SERVICE}>service</NativeSelectOption>
						{keys.map((key) => (
							<NativeSelectOption key={key.name} value={key.name}>
								{key.name}
							</NativeSelectOption>
						))}
						{/* A group-by carried in from a URL keeps working even if the key
						    has no datapoints in the current range. */}
						{options.groupBy !== GROUP_BY_SERVICE &&
						!keys.some((key) => key.name === options.groupBy) ? (
							<NativeSelectOption value={options.groupBy}>{options.groupBy}</NativeSelectOption>
						) : null}
					</NativeSelect>
				</label>

				<label className="flex items-center gap-1.5 text-xs text-muted-foreground">
					Series
					<NativeSelect
						size="sm"
						value={String(options.seriesLimit)}
						onChange={(e) => onSeriesLimitChange(Number(e.target.value))}
					>
						{SERIES_LIMIT_OPTIONS.map((limit) => (
							<NativeSelectOption key={limit} value={limit}>
								Top {limit}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</label>

				<form className="flex flex-1 items-center gap-1.5" onSubmit={addFilter}>
					<span className="text-xs text-muted-foreground">Where</span>
					<NativeSelect
						size="sm"
						aria-label="Filter attribute"
						value={activeKey}
						onChange={(e) => setDraftKey(e.target.value)}
						disabled={keys.length === 0}
					>
						{keys.length === 0 ? (
							<NativeSelectOption value="">
								{attributeKeys.isPending ? "Loading…" : "No attributes"}
							</NativeSelectOption>
						) : null}
						{keys.map((key) => (
							<NativeSelectOption key={key.name} value={key.name}>
								{key.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
					<span className="text-xs text-muted-foreground">=</span>
					<Input
						size="sm"
						className="max-w-56"
						aria-label="Filter value"
						list={valueListId}
						value={draftValue}
						disabled={!activeKey}
						placeholder="value"
						onChange={(e) => setDraftValue(e.target.value)}
					/>
					<datalist id={valueListId}>
						{(attributeValues.data ?? []).map((value) => (
							<option key={value.name} value={value.name} />
						))}
					</datalist>
					<Button type="submit" variant="outline" size="sm" disabled={!activeKey}>
						Add
					</Button>
				</form>
			</div>

			<ActiveFilterChips
				className="mb-0"
				chips={options.filters.map((filter, index) => ({
					id: `${filter.key}:${filter.value}:${index}`,
					label: filter.key,
					values: [filter.value || "(empty)"],
					onRemove: () => removeFilter(index),
				}))}
				onClearAll={() => onFiltersChange([])}
			/>
		</div>
	)
}
