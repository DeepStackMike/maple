// Typed Service Version Catalog
//
// `service.version` is the one release identifier that reaches no rollup. The
// service-overview tiers carry `CommitSha` — `vcs.ref.head.revision`, which only
// an instrumented build stamps — and nothing else about a release; every other
// pre-extracted column on `service_overview_spans` was chosen for the hosted
// services list, whose "Last deploy" cell resolves a SHA against the VCS
// integration. A local Maple has no VCS integration and, in practice, no
// `vcs.*` attributes either: the SDKs stamp `service.version` from a semver
// release string and deliberately leave `vcs.*` alone unless the value is
// SHA-shaped (see `packages/effect-sdk/src/server/resource.ts`). So on a local
// store the hosted deploy column is empty for every row, and the version that
// *is* there sits in `traces.ResourceAttributes` where no projection can see it.
//
// Hence a query against raw `traces`, not against a tier. That is the expensive
// shape on a cloud-sized window and this builder does not claim otherwise — it
// is the same trade `serviceMapEdgesQuery` makes, and for the same reason: a
// store that holds an afternoon can afford the scan that a store holding a year
// cannot. `IsEntryPoint` narrows it to the span population
// `service_overview_spans` is built from, so a version row and an overview row
// describe the same requests.

import { from, param } from "@maple-dev/clickhouse-builder"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { deploymentEnvExpr } from "@maple/domain/tinybird/semconv-renames"
import { Traces } from "../tables"

export interface ServiceCatalogVersionsOpts {
	/** Restrict to one service; omit for the whole fleet. */
	readonly serviceName?: string
	readonly limit?: number
}

export interface ServiceCatalogVersionsOutput {
	readonly serviceName: string
	readonly environment: string
	readonly version: string
	readonly spanCount: number
	/** Earliest span carrying this version inside the window — "deployed at", clamped. */
	readonly firstSeen: string
	readonly lastSeen: string
}

/**
 * Every `service.version` seen per (service, environment), with the window-
 * clamped first and last span that carried it.
 *
 * Grouped by environment rather than collapsed to the service, because a
 * version is a property of a deployment: staging is routinely a release ahead
 * of production and a single "latest version" per service would report one of
 * them as the other's. The caller picks the row it wants — `lastSeen` descending
 * puts the version still receiving traffic first, which is the one a services
 * list means by "current".
 *
 * `firstSeen` is bounded by the query window, so a version deployed before the
 * window opened reports the window's start. That is the same clamp the hosted
 * list's per-commit `firstSeen` carries, and it is why the UI says "seen" rather
 * than "deployed".
 */
export function serviceCatalogVersionsQuery(opts: ServiceCatalogVersionsOpts = {}) {
	return from(Traces)
		.select(($) => ({
			serviceName: $.ServiceName,
			environment: deploymentEnvExpr($.ResourceAttributes),
			version: $.ResourceAttributes.get("service.version"),
			spanCount: CH.count(),
			// `toString` rather than the bare aggregate: `Timestamp` is DateTime64
			// and the row is decoded as text on both wire formats.
			firstSeen: CH.toString_(CH.min_($.Timestamp)),
			lastSeen: CH.toString_(CH.max_($.Timestamp)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(CH.toDateTime(param.dateTimeString("startTime"))),
			$.Timestamp.lt(CH.toDateTime(param.dateTimeString("endTime"))),
			// The entry-point population `service_overview_spans` projects, so the
			// version beside a row's metrics was measured over the same spans.
			$.IsEntryPoint.eq(1),
			// Dropped before the GROUP BY, not after: an unversioned span carries
			// no release to report, and keeping it would put a `version: ''` row
			// beside the real ones for every service that stamps the attribute on
			// only some of its deployments.
			$.ResourceAttributes.get("service.version").neq(""),
			opts.serviceName ? $.ServiceName.eq(opts.serviceName) : undefined,
		])
		.groupBy("serviceName", "environment", "version")
		.orderBy(["lastSeen", "desc"], ["spanCount", "desc"])
		.limit(opts.limit ?? 500)
		.format("JSON")
}
