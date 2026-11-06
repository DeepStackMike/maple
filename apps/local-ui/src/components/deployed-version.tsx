// Sidebar footer line naming what is deployed: Maple's version as the server
// reports it on `/local/status`, and this dashboard's build commit (baked in at
// build time from VITE_BUILD_COMMIT; absent in dev builds).

import { useLocalServerStatus } from "../hooks/use-local-server-status"

const BUILD_COMMIT: string = import.meta.env.VITE_BUILD_COMMIT ?? ""

export function describeDeployedVersion(
	mapleVersion: string | null,
	buildCommit: string,
): { readonly label: string; readonly title: string } | null {
	const parts: Array<string> = []
	const title: Array<string> = []
	if (mapleVersion) {
		parts.push(`Maple v${mapleVersion}`)
		title.push(`Maple Local v${mapleVersion}`)
	}
	if (buildCommit) {
		parts.push(`UI ${buildCommit.slice(0, 7)}`)
		title.push(`Dashboard build ${buildCommit}`)
	}
	return parts.length === 0 ? null : { label: parts.join(" · "), title: title.join("\n") }
}

export function DeployedVersion() {
	const { data } = useLocalServerStatus()
	const described = describeDeployedVersion(data?.version ?? null, BUILD_COMMIT)
	if (!described) return null
	return (
		<span
			title={described.title}
			className="truncate px-1 font-mono text-[11px] text-muted-foreground tabular-nums group-data-[collapsible=icon]:hidden"
		>
			{described.label}
		</span>
	)
}
