import { NativeSelect, NativeSelectOption } from "@maple/ui/components/ui/native-select"
import { SitemapIcon } from "@maple/ui/components/icons"
import { useLocalNamespaces } from "../hooks/use-local-namespaces"
import { useNamespace } from "../hooks/use-namespace"
import { ALL_PROJECTS_LABEL } from "../lib/namespace"

/**
 * The project selector, in the header beside the connection state.
 *
 * In the header and not a toolbar because it is not one view's filter: it says
 * which project the whole session is about, the way the org switcher does in
 * the cloud app. Every view that can honour it honours the same choice, and the
 * ones that cannot say so where they render.
 *
 * **Renders nothing when there is nothing to choose between.** A Maple whose
 * services set no `service.namespace` — the single-project case, which is most
 * of them — would otherwise get a permanent control with one option in it,
 * saying "All projects" about the only project there is.
 */
export function NamespaceSelect() {
	const namespaces = useLocalNamespaces()
	const [namespace, setNamespace] = useNamespace()

	const options = namespaces.data ?? []
	// A selected project that has gone quiet is still selected — it must stay in
	// the list, or the control would silently read "All projects" while the views
	// below it are filtered to something the reader can no longer see.
	const missingSelection = namespace && !options.some((option) => option.namespace === namespace)
	if (options.length === 0 && !missingSelection) return null

	return (
		<span className="flex items-center gap-1.5" title="Filter every view by OTel service.namespace">
			<SitemapIcon size={13} className="text-muted-foreground" />
			<NativeSelect
				size="sm"
				aria-label="Project"
				value={namespace ?? ""}
				onChange={(event) => setNamespace(event.target.value || undefined)}
			>
				<NativeSelectOption value="">{ALL_PROJECTS_LABEL}</NativeSelectOption>
				{missingSelection ? (
					<NativeSelectOption value={namespace}>{namespace}</NativeSelectOption>
				) : null}
				{options.map((option) => (
					<NativeSelectOption key={option.namespace} value={option.namespace}>
						{option.namespace}
					</NativeSelectOption>
				))}
			</NativeSelect>
		</span>
	)
}
