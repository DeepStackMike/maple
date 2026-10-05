// Projects (service.namespace) across every signal.
//
// The header's project selector is a standing filter over the whole local UI,
// but only spans carry `service.namespace` everywhere: `error_events`,
// `product_events` and the service-map edges know a row's service and nothing
// about its project. So the selector works in two steps — which projects exist,
// and which services belong to the chosen one — and every view that cannot
// filter on the namespace itself filters on that service list instead.
//
// Both read the resource attribute off every table that has one (spans, logs,
// browser sessions, the three metric kinds). Spans alone would miss a project
// that only records sessions — a mobile app whose network calls go to someone
// else's backend — and its services would then vanish the moment any project
// was selected, including their own.
//
// Mapping by service name is exact as long as a service name belongs to one
// project, which the Harbr naming convention (`<namespace>-<component>`)
// guarantees. Where two projects do share a name, a view filtered by service
// shows that service's rows from both; spans and services, which filter on the
// namespace directly, stay exact.

import * as CH from "@maple-dev/effect-clickhouse/expr"
import { from, fromUnion, param, unionAll } from "@maple-dev/effect-clickhouse"
import { Logs, MetricsGauge, MetricsHistogram, MetricsSum, SessionReplays, Traces } from "../tables"

const NAMESPACE_KEY = "service.namespace"

/** The pairs one table holds, optionally restricted to one namespace. */
const pairs = (namespace?: string) => {
	const where = ($: {
		OrgId: CH.Expr<string>
		ResourceAttributes: { get(k: string): CH.Expr<string> }
	}) => [
		$.OrgId.eq(param.string("orgId")),
		namespace === undefined
			? $.ResourceAttributes.get(NAMESPACE_KEY).neq("")
			: $.ResourceAttributes.get(NAMESPACE_KEY).eq(namespace),
	]
	const select = ($: {
		ServiceName: CH.Expr<string>
		ResourceAttributes: { get(k: string): CH.Expr<string> }
	}) => ({
		namespace: $.ResourceAttributes.get(NAMESPACE_KEY),
		serviceName: $.ServiceName,
		rows: CH.count(),
	})
	return unionAll(
		from(Traces)
			.select(select)
			.where(($) => [
				...where($),
				$.Timestamp.gte(param.dateTimeString("startTime")),
				$.Timestamp.lte(param.dateTimeString("endTime")),
			])
			.groupBy("namespace", "serviceName"),
		from(Logs)
			.select(select)
			.where(($) => [
				...where($),
				$.Timestamp.gte(param.dateTimeString("startTime")),
				$.Timestamp.lte(param.dateTimeString("endTime")),
			])
			.groupBy("namespace", "serviceName"),
		from(SessionReplays)
			.select(select)
			.where(($) => [
				...where($),
				$.StartTime.gte(param.dateTimeString("startTime")),
				$.StartTime.lte(param.dateTimeString("endTime")),
			])
			.groupBy("namespace", "serviceName"),
		from(MetricsSum)
			.select(select)
			.where(($) => [
				...where($),
				$.TimeUnix.gte(param.dateTimeString("startTime")),
				$.TimeUnix.lte(param.dateTimeString("endTime")),
			])
			.groupBy("namespace", "serviceName"),
		from(MetricsGauge)
			.select(select)
			.where(($) => [
				...where($),
				$.TimeUnix.gte(param.dateTimeString("startTime")),
				$.TimeUnix.lte(param.dateTimeString("endTime")),
			])
			.groupBy("namespace", "serviceName"),
		from(MetricsHistogram)
			.select(select)
			.where(($) => [
				...where($),
				$.TimeUnix.gte(param.dateTimeString("startTime")),
				$.TimeUnix.lte(param.dateTimeString("endTime")),
			])
			.groupBy("namespace", "serviceName"),
	)
}

export interface ResourceNamespacesOpts {
	readonly limit?: number
}

export interface ResourceNamespacesOutput {
	/** The `service.namespace` resource attribute's value. Never empty. */
	readonly namespace: string
	/** Rows (spans, logs, sessions, metric points) that named it in the window. */
	readonly spanCount: number
}

/**
 * Every `service.namespace` any signal reported in the window, busiest first.
 *
 * Services that set no namespace are not a project called "" — they are the
 * ones an "All projects" selection is the only way to see.
 */
export function resourceNamespacesQuery(opts: ResourceNamespacesOpts = {}) {
	return fromUnion(pairs(), "namespace_pairs")
		.select(($) => ({ namespace: $.namespace, spanCount: CH.sum($.rows) }))
		.groupBy("namespace")
		.orderBy(["spanCount", "desc"], ["namespace", "asc"])
		.limit(opts.limit ?? 100)
		.format("JSON")
}

export interface NamespaceServicesOpts {
	readonly namespace: string
}

export interface NamespaceServicesOutput {
	readonly serviceName: string
}

/** The services that reported `service.namespace = namespace` on any signal in the window. */
export function namespaceServicesQuery(opts: NamespaceServicesOpts) {
	return fromUnion(pairs(opts.namespace), "namespace_pairs")
		.select(($) => ({ serviceName: $.serviceName }))
		.groupBy("serviceName")
		.orderBy(["serviceName", "asc"])
		.limit(1000)
		.format("JSON")
}
