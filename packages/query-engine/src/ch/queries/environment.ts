// The deployment environment, including the one nobody named.
//
// A row whose resource attributes carry no `deployment.environment.name` (nor
// the deprecated `deployment.environment`) reads as `''` — a map miss — and the
// materialized views that pre-extract `DeploymentEnv` store the same `''`. That
// empty string is not a value anybody can select: the DSL reads `''` as "no
// filter", so every environment list dropped it and every environment filter
// excluded the rows behind it. Telemetry that forgot the attribute therefore sat
// outside every environment rather than inside a named one, and the only way to
// see it was to clear the filter entirely.
//
// So the read side gives it a name. Everywhere an environment is listed,
// grouped, or compared, the column is read through {@link envLabel}, which maps
// `''` to the literal `unknown`. One expression in both positions is what makes
// it work: the facet that offers `unknown` and the predicate that matches it are
// the same `coalesce(nullIf(env, ''), 'unknown')`, so selecting the option
// returns exactly the rows that produced it. The `nullIf`/`coalesce` spelling is
// the one `deploymentEnvExpr` already uses for the same "a map miss is `''`"
// problem, and unlike `if(env = '', …, env)` it names the column once — which
// matters when the column is itself the rename coalesce.
//
// This is a read-side label, not a stored value. Nothing writes `unknown` into
// `DeploymentEnv` — `deploymentEnvExpr` and `DEPLOYMENT_ENV_SQL` stay the raw
// coalesce, because the MV that uses them must keep agreeing byte-for-byte with
// the raw-table fallback. A service that really should be tagged is still
// untagged; `unknown` makes that visible and filterable instead of invisible.

import * as CH from "@maple-dev/effect-clickhouse/expr"
import { deploymentEnvExpr } from "@maple/domain/tinybird/semconv-renames"

/**
 * The environment a row with no environment attribute belongs to.
 *
 * Lower-case because it is a value, not a caption: it travels in the `env` URL
 * param and in the DSL's environment filters beside `production` and `staging`.
 * A UI that title-cases its labels title-cases this one too.
 */
export const UNKNOWN_ENVIRONMENT = "unknown"

/**
 * An environment column or expression, with the empty value named.
 *
 * Apply it to `DeploymentEnv` on the rollups and to `deploymentEnvExpr`
 * on the raw tables, in the SELECT and in the WHERE alike — the round trip from
 * "what environments are there" to "show me that one" only closes if both sides
 * are this expression.
 */
export const envLabel = (environment: CH.Expr<string>): CH.Expr<string> =>
	CH.coalesce(CH.nullIf(environment, ""), CH.lit(UNKNOWN_ENVIRONMENT))

/**
 * The environment of a span/log/session row, off its resource attribute map:
 * the semconv rename coalesce, then the empty-to-`unknown` label.
 */
export const resourceEnvLabel = (resourceAttributes: {
	get(key: string): CH.Expr<string>
}): CH.Expr<string> => envLabel(deploymentEnvExpr(resourceAttributes))

/**
 * A service column restricted to a list — the header's project, resolved to its
 * services. `undefined` applies no filter; an empty list matches nothing (a
 * project with no services in the window has nothing to show), where a bare
 * `IN ()` would not even parse.
 */
export const servicesIn = (
	column: CH.Expr<string>,
	services: readonly string[] | undefined,
): CH.Condition | undefined =>
	services === undefined
		? undefined
		: services.length === 0
			? CH.rawCond("1 = 0")
			: CH.inList(column, services)
