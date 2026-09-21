import { NativeSelect, NativeSelectOption } from "@maple/ui/components/ui/native-select"
import { LayersIcon } from "@maple/ui/components/icons"
import { useLocalEnvironments } from "../hooks/use-local-environments"
import { useEnvironment } from "../hooks/use-environment"
import { ALL_ENVIRONMENTS_LABEL } from "../lib/environment"

/**
 * The deployment-environment selector, in the header beside the project one.
 *
 * In the header for the same reason its neighbour is: it is not one view's
 * filter but a statement about which deployment the whole session is about, and
 * every view that can honour it honours the same choice.
 *
 * **Renders nothing when there is nothing to choose between.** A Maple whose
 * services set no `deployment.environment.name` — which is most local runs —
 * would otherwise get a permanent control offering "All environments" and
 * nothing else. A single environment is hidden too: naming the only deployment
 * there is adds a control without adding a choice.
 */
export function EnvironmentSelect() {
	const environments = useLocalEnvironments()
	const [environment, setEnvironment] = useEnvironment()

	const options = environments.data ?? []
	// A selected environment that has gone quiet is still selected — it has to
	// stay listed, or the control would read "All environments" while the views
	// below it were filtered to something the reader can no longer see.
	const missingSelection = environment !== undefined && !options.includes(environment)
	if (options.length < 2 && !missingSelection) return null

	return (
		<span className="flex items-center gap-1.5" title="Filter every view by deployment.environment">
			<LayersIcon size={13} className="text-muted-foreground" />
			<NativeSelect
				size="sm"
				aria-label="Environment"
				value={environment ?? ""}
				onChange={(event) => setEnvironment(event.target.value || undefined)}
			>
				<NativeSelectOption value="">{ALL_ENVIRONMENTS_LABEL}</NativeSelectOption>
				{missingSelection ? (
					<NativeSelectOption value={environment}>{environment}</NativeSelectOption>
				) : null}
				{options.map((option) => (
					<NativeSelectOption key={option} value={option}>
						{option}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</span>
	)
}
