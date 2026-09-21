import { describe, expect, it } from "vitest"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { compile } from "@maple-dev/clickhouse-builder/sql"
import { UNKNOWN_ENVIRONMENT, envLabel, resourceEnvLabel } from "./environment"

const render = (expr: CH.Expr<string>) => compile(expr.toFragment())

const DeploymentEnv = CH.dynamicColumn<string>("DeploymentEnv")
const resourceAttributes = {
	get: (key: string) => CH.mapGet(CH.dynamicColumn<Record<string, string>>("ResourceAttributes"), key),
}

describe("envLabel", () => {
	// The whole point of the label: the option the facet offers and the predicate
	// the filter emits are the same expression, so a reader who picks `unknown`
	// gets exactly the rows that produced the option. Asserting the rendered text
	// is asserting that — anything that drifts here splits the two apart.
	it("names the empty environment `unknown` and leaves every other value alone", () => {
		expect(render(envLabel(DeploymentEnv))).toBe("coalesce(nullIf(DeploymentEnv, ''), 'unknown')")
	})

	it("reads the same in a predicate as it does in a projection", () => {
		const projection = render(envLabel(DeploymentEnv))
		const predicate = compile(envLabel(DeploymentEnv).eq(UNKNOWN_ENVIRONMENT).toFragment())
		expect(predicate).toBe(`${projection} = 'unknown'`)
	})

	// `unknown` is a value, not a caption: it travels in the `env` URL param and
	// sits in the same IN-list as `production`.
	it("is a lower-case value", () => {
		expect(UNKNOWN_ENVIRONMENT).toBe("unknown")
	})
})

describe("resourceEnvLabel", () => {
	// Composed on top of the semconv coalesce rather than re-spelling the two
	// keys: a row tagged only with the deprecated `deployment.environment` is a
	// tagged row, and must not fall into `unknown`.
	it("falls back through both semconv spellings before reaching `unknown`", () => {
		expect(render(resourceEnvLabel(resourceAttributes))).toBe(
			"coalesce(nullIf(coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), " +
				"ResourceAttributes['deployment.environment']), ''), 'unknown')",
		)
	})
})
