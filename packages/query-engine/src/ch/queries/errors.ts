// Typed Error Queries
//
// DSL-based query definitions for error aggregation and timeseries.

import { finiteOrZero } from "./format"
import { edgeCondition, interiorConditions } from "./rollup-splice"
import * as CH from "@maple-dev/effect-clickhouse/expr"
// From the root, not `/expr`: these overloads take a `CHQuery`, keeping the
// subquery's params, table names and column types checked.
import { exists, inSubquery } from "@maple-dev/effect-clickhouse"
import { param } from "@maple-dev/effect-clickhouse"
import { from, fromQuery, fromUnion, type CHQuery, type ColumnAccessor } from "@maple-dev/effect-clickhouse"
import type { ColumnDefs } from "@maple-dev/effect-clickhouse/types"
import * as T from "@maple-dev/effect-clickhouse/types"
import { unionAll, type CHUnionQuery } from "@maple-dev/effect-clickhouse"
import type { SpanId, TraceId } from "@maple/domain"
import { Schema } from "effect"
import {
	ErrorEvents,
	ErrorEventsByTime,
	ErrorFingerprintsMinutely,
	ServiceUsage,
	SessionEvents,
	SessionReplays,
	TraceDetailSpans,
	TraceFacetsHourly,
	TraceListMv,
	Traces,
} from "../tables"
import {
	buildProjectedMapExpr,
	inclusionValues,
	inclusionCondition,
	matchOrIn,
	nameExclusionCondition,
	type FacetOutput,
} from "./query-helpers"
import { envLabel, resourceEnvLabel } from "./environment"
import { httpDisplaySpanName } from "../../traces-shared"
import { CHNumber } from "../schema"

function errorEventsTableForRecentScan(opts: {
	fingerprintHashes?: readonly string[]
}): typeof ErrorEvents | typeof ErrorEventsByTime {
	// Fingerprint-filtered lookups align with error_events' key
	// (OrgId, FingerprintHash, Timestamp). Broad recent-window scans align with
	// error_events_by_time's key (OrgId, Timestamp, FingerprintHash).
	return opts.fingerprintHashes?.length ? ErrorEvents : ErrorEventsByTime
}

const fingerprintHashLiteral = (hash: string) => CH.toUInt64(CH.lit(hash))
const fingerprintHashEq = (expr: CH.Expr<number>, hash: string) => expr.eq(fingerprintHashLiteral(hash))

/**
 * Whether a fingerprint is one the warehouse could hold.
 *
 * `error_issues.fingerprint_hash` is shared by three issue kinds: "error" rows
 * hold the decimal UInt64 that ClickHouse computed, while "alert" and
 * "integration" rows reuse the column for a synthetic key
 * (`alert:{ruleId}:{groupKey}`, `planetscale:{database}:{event}`). Only the
 * first kind ever appears in `error_events`.
 *
 * The failure this prevents is not a wrong row, it is a dead request:
 * `toUInt64('alert:…')` does not skip that value, it aborts the whole query, so
 * a single alert-backed issue in a batch of twenty 500s the lot. It did — the
 * errors hub's sparklines, 83 times in three days, until #573 filtered the list
 * client-side. This is the same guard on the side that cannot be bypassed by a
 * different caller.
 */
const isWarehouseFingerprint = (hash: string) => /^[0-9]+$/.test(hash)

const fingerprintHashIn = (expr: CH.Expr<number>, hashes: readonly string[]) => {
	const usable = hashes.filter(isWarehouseFingerprint)
	// Dropping every hash is a real answer, not an error: the caller asked about
	// fingerprints that cannot exist here, and the answer is no rows. Emitted as
	// a false literal because `IN ()` is a ClickHouse syntax error.
	if (usable.length === 0) return CH.rawCond("1 = 0")
	return CH.inExprList(expr, usable.map(fingerprintHashLiteral))
}

/**
 * Filters every errors surface shares. `errorLabels` and `serviceVersions` are
 * the sidebar's "Error Type" and "Version" facets; both are plain string
 * columns on the error-events tables, so they lower to a straight IN list.
 */
export interface ErrorsSharedFilters {
	services?: readonly string[]
	deploymentEnvs?: readonly string[]
	errorLabels?: readonly string[]
	serviceVersions?: readonly string[]
	excludedServices?: readonly string[]
	excludedDeploymentEnvs?: readonly string[]
	excludedErrorLabels?: readonly string[]
	excludedServiceVersions?: readonly string[]
}

/**
 * A facet dimension, named by its *inclusion* field. Both polarities of one dimension share a name
 * here on purpose: `except` has to drop a section's exclusions along with its inclusions, or the
 * value you just excluded would count zero in the very section you excluded it from.
 */
type ErrorsFilterDimension = "services" | "deploymentEnvs" | "errorLabels" | "serviceVersions"

const sharedFilterConditions = (
	$: {
		ServiceName: CH.Expr<string>
		DeploymentEnv: CH.Expr<string>
		ErrorLabel: CH.Expr<string>
		ServiceVersion: CH.Expr<string>
	},
	opts: ErrorsSharedFilters,
	/**
	 * The one dimension to leave unfiltered. A facet section conditions its
	 * counts on every OTHER active filter but not its own, or ticking one option
	 * would zero every alternative in the same section and leave no way back.
	 */
	except?: ErrorsFilterDimension,
): Array<CH.Condition | undefined> => [
	opts.services?.length && except !== "services" ? CH.inList($.ServiceName, opts.services) : undefined,
	opts.deploymentEnvs?.length && except !== "deploymentEnvs"
		? CH.inList(envLabel($.DeploymentEnv), opts.deploymentEnvs)
		: undefined,
	opts.errorLabels?.length && except !== "errorLabels"
		? CH.inList($.ErrorLabel, opts.errorLabels)
		: undefined,
	opts.serviceVersions?.length && except !== "serviceVersions"
		? CH.inList($.ServiceVersion, opts.serviceVersions)
		: undefined,
	opts.excludedServices?.length && except !== "services"
		? CH.notInList($.ServiceName, opts.excludedServices)
		: undefined,
	opts.excludedDeploymentEnvs?.length && except !== "deploymentEnvs"
		? CH.notInList(envLabel($.DeploymentEnv), opts.excludedDeploymentEnvs)
		: undefined,
	opts.excludedErrorLabels?.length && except !== "errorLabels"
		? CH.notInList($.ErrorLabel, opts.excludedErrorLabels)
		: undefined,
	opts.excludedServiceVersions?.length && except !== "serviceVersions"
		? CH.notInList($.ServiceVersion, opts.excludedServiceVersions)
		: undefined,
]

// Errors by type
//
// Top Errors groups the canonical `error_events` rows by the ingest-computed
// `FingerprintHash` (the same identity the Issues system uses) and labels them
// with the stored `ErrorLabel`. The error identity is the stable fingerprint
// hash (string), not a query-time heuristic — see materializations.ts /
// fingerprint.ts for how the hash + label are derived.

/**
 * Error identities that violate the "every failure is a namespaced tagged error" policy: labels
 * outside the org's own namespace (library tags such as `AI.Error`, bare `Error`), plus the
 * markers Maple emits when a request ended in a 5xx or the unexpected-error envelope.
 */
export interface UnexpectedIdentityFilter {
	readonly namespacePrefix: string
	readonly markerLabels: readonly string[]
}

export const DEFAULT_ERROR_NAMESPACE_PREFIX = "@maple/"

export const UNEXPECTED_IDENTITY_MARKERS: readonly string[] = [
	// The SDK's marker for a server span whose handler rendered a 5xx (the
	// Worker bridge answers a defect that way); the api's own marker before it.
	"HttpServerErrorResponse",
	"@maple/api/http/Http5xxResponseError",
	"@maple/http/v2/UnexpectedError",
	"@maple/http/v1/V1UnexpectedError",
]

export interface ErrorsByTypeOpts extends ErrorsSharedFilters {
	rootOnly?: boolean
	fingerprintHashes?: readonly string[]
	unexpectedIdentity?: UnexpectedIdentityFilter
	limit?: number
}

export interface ErrorsByTypeOutput {
	readonly fingerprintHash: string
	readonly errorLabel: string
	readonly sampleMessage: string
	readonly count: number
	readonly affectedServicesCount: number
	/** Up to three of the services that raised it, sorted; `affectedServicesCount` has the total. */
	readonly serviceNames: readonly string[]
	readonly firstSeen: string
	readonly lastSeen: string
}

/** How many service names a by-type row carries; enough to name a small blast radius. */
const ERRORS_BY_TYPE_SERVICE_NAMES = 3

export function errorsByTypeQuery(opts: ErrorsByTypeOpts) {
	return from(errorEventsTableForRecentScan(opts))
		.select(($) => ({
			fingerprintHash: CH.toString_($.FingerprintHash),
			errorLabel: CH.any_($.ErrorLabel),
			sampleMessage: CH.any_($.StatusMessage),
			count: CH.count(),
			affectedServicesCount: CH.uniq($.ServiceName),
			serviceNames: CH.arraySort(
				CH.groupUniqArrayIf(ERRORS_BY_TYPE_SERVICE_NAMES)($.ServiceName, $.ServiceName.neq("")),
			),
			firstSeen: CH.min_($.Timestamp),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeSeconds("startTime")),
			$.Timestamp.lte(param.dateTimeSeconds("endTime")),
			CH.whenTrue(!!opts.rootOnly, () => $.ParentSpanId.eq("")),
			...sharedFilterConditions($, opts),
			opts.fingerprintHashes?.length
				? fingerprintHashIn($.FingerprintHash, opts.fingerprintHashes)
				: undefined,
			opts.unexpectedIdentity
				? $.ErrorLabel.notLike(`${likeLiteral(opts.unexpectedIdentity.namespacePrefix)}%`).or(
						CH.inList($.ErrorLabel, opts.unexpectedIdentity.markerLabels),
					)
				: undefined,
		])
		.groupBy("fingerprintHash")
		.orderBy(["count", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

// Error sample stack
//
// `errorsByTypeQuery` answers "what is failing and how often", and it is the
// only builder the errors list runs. It has never selected the stack: it is one
// row per fingerprint over a window of thousands of events, and carrying a
// multi-kilobyte `ExceptionStacktrace` on every row of a 50-row list is the
// payload of the whole list spent on text that is shown for one expanded row.
//
// So the stack is its own builder, fetched for the fingerprint the user opened.
// That keeps `errorsByTypeQuery`'s SQL byte-identical — it is in the catalog
// baseline, and a widened SELECT there would read as a change to the list.
//
// Every field is `argMax(…, Timestamp)` rather than `any()`: the four columns
// have to describe ONE occurrence. A fingerprint groups events that share a
// type and a top frame, not events with identical stacks — the same error
// raised under two call paths differs below the top frame, and `any()` picks
// each column independently, which can splice a message from one occurrence
// onto a stack from another. The latest is also the one worth showing: it is
// the build the user is running.

export interface ErrorSampleStackOpts {
	fingerprintHash: string
}

export interface ErrorSampleStackOutput {
	readonly exceptionType: string
	readonly exceptionMessage: string
	readonly exceptionStacktrace: string
	readonly topFrame: string
	readonly lastSeen: string
}

export function errorSampleStackQuery(opts: ErrorSampleStackOpts) {
	return from(ErrorEvents)
		.select(($) => ({
			exceptionType: CH.argMax($.ExceptionType, $.Timestamp),
			exceptionMessage: CH.argMax($.ExceptionMessage, $.Timestamp),
			exceptionStacktrace: CH.argMax($.ExceptionStacktrace, $.Timestamp),
			topFrame: CH.argMax($.TopFrame, $.Timestamp),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			// Through the list helper, not `fingerprintHashEq`: an issue whose
			// fingerprint is a synthetic alert/integration key lowers to `1 = 0`
			// here instead of aborting the request on `toUInt64('alert:…')`.
			fingerprintHashIn($.FingerprintHash, [opts.fingerprintHash]),
			$.Timestamp.gte(param.dateTimeSeconds("startTime")),
			$.Timestamp.lte(param.dateTimeSeconds("endTime")),
		])
		.format("JSON")
}

// Error versions — one fingerprint's occurrences, split by the build they ran on
//
// "Is this new?" is the first question asked of an error and the one the errors
// list could not answer. `errorsByTypeQuery` already carries `firstSeen`, but a
// timestamp only says *when*, and what a reader acts on is *which deploy*:
// an error whose every occurrence is on `1.4.2` is a regression that shipped
// this afternoon, and the same error spread evenly across six versions is a bug
// that has always been there.
//
// `error_events.ServiceVersion` is `service.version` off the resource,
// materialized on every row since the v6→v7 local migration
// (`v6-to-v7-error-service-version.ts`), so this is a GROUP BY and not a join.
//
// Batched over `fingerprintHashes`, like `errorsSparkQuery`: the list renders
// fifty rows and every one of them wants its introducing version, which as one
// query per row is fifty round trips against a chDB process that runs them
// serially. Fingerprint-filtered, so it rides `error_events`' (OrgId,
// FingerprintHash, Timestamp) key rather than scanning the window.
//
// Rows with an empty `ServiceVersion` are kept, not dropped. They are what an
// exporter that never set `service.version` produces, and dropping them would
// leave a per-version table whose counts do not add up to the count in the list
// row above it — the one thing a breakdown must never do.

export interface ErrorVersionsOpts extends ErrorsSharedFilters {
	fingerprintHashes: readonly string[]
	rootOnly?: boolean
	limit?: number
}

export interface ErrorVersionsOutput {
	readonly fingerprintHash: string
	/** `service.version` off the resource; `''` when the exporter set none. */
	readonly serviceVersion: string
	readonly count: number
	readonly firstSeen: string
	readonly lastSeen: string
}

export function errorVersionsQuery(opts: ErrorVersionsOpts) {
	return (
		from(ErrorEvents)
			.select(($) => ({
				// Identity UInt64: unwrapped it corrupts above 2^53.
				fingerprintHash: CH.toString_($.FingerprintHash),
				serviceVersion: $.ServiceVersion,
				count: CH.count(),
				firstSeen: CH.min_($.Timestamp),
				lastSeen: CH.max_($.Timestamp),
			}))
			.where(($) => [
				$.OrgId.eq(param.string("orgId")),
				fingerprintHashIn($.FingerprintHash, opts.fingerprintHashes),
				$.Timestamp.gte(param.dateTimeSeconds("startTime")),
				$.Timestamp.lte(param.dateTimeSeconds("endTime")),
				CH.whenTrue(!!opts.rootOnly, () => $.ParentSpanId.eq("")),
				...sharedFilterConditions($, opts),
			])
			.groupBy("fingerprintHash", "serviceVersion")
			// Grouped by fingerprint first so a truncating LIMIT cuts whole
			// fingerprints off the tail rather than silently amputating the newest
			// versions of every row on the page; oldest-first inside a fingerprint is
			// the order "introduced in" reads off.
			.orderBy(["fingerprintHash", "asc"], ["firstSeen", "asc"])
			.limit(opts.limit ?? 500)
			.format("JSON")
	)
}

// Error version slices — the same split, per (service, environment)
//
// "Introduced in" and the compare-versions table compare a version with the
// one it replaced, and a predecessor only means something on the same service
// in the same environment: `2.4.0` on staging did not replace `2.3.2` on
// production. `errorVersionsQuery` merges those, so this keeps its filters and
// adds the two dimensions rather than making callers run it once per pair.
// The environment goes through `envLabel` so an untagged slice is `unknown`,
// the name every other errors query gives it.

export interface ErrorVersionSlicesOutput extends ErrorVersionsOutput {
	readonly serviceName: string
	readonly environment: string
}

export function errorVersionSlicesQuery(opts: ErrorVersionsOpts) {
	return (
		from(ErrorEvents)
			.select(($) => ({
				fingerprintHash: CH.toString_($.FingerprintHash),
				serviceName: $.ServiceName,
				environment: envLabel($.DeploymentEnv),
				serviceVersion: $.ServiceVersion,
				count: CH.count(),
				firstSeen: CH.min_($.Timestamp),
				lastSeen: CH.max_($.Timestamp),
			}))
			.where(($) => [
				$.OrgId.eq(param.string("orgId")),
				fingerprintHashIn($.FingerprintHash, opts.fingerprintHashes),
				$.Timestamp.gte(param.dateTimeSeconds("startTime")),
				$.Timestamp.lte(param.dateTimeSeconds("endTime")),
				CH.whenTrue(!!opts.rootOnly, () => $.ParentSpanId.eq("")),
				...sharedFilterConditions($, opts),
			])
			.groupBy("fingerprintHash", "serviceName", "environment", "serviceVersion")
			// Whole fingerprints first under a truncating LIMIT, as above.
			.orderBy(
				["fingerprintHash", "asc"],
				["serviceName", "asc"],
				["environment", "asc"],
				["firstSeen", "asc"],
			)
			.limit(opts.limit ?? 2000)
			.format("JSON")
	)
}

/** A namespace prefix is a literal, so its `%`/`_` must not act as LIKE wildcards. */
const likeLiteral = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`)

// Errors timeseries

export interface ErrorsTimeseriesOpts {
	fingerprintHash: string
	services?: readonly string[]
}

export interface ErrorsTimeseriesOutput {
	readonly bucket: string
	readonly count: number
}

export function errorsTimeseriesQuery(opts: ErrorsTimeseriesOpts) {
	return from(ErrorEvents)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			fingerprintHashEq($.FingerprintHash, opts.fingerprintHash),
			$.Timestamp.gte(param.dateTimeSeconds("startTime")),
			$.Timestamp.lte(param.dateTimeSeconds("endTime")),
			opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
		])
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// Errors spark — bucketed counts for MANY fingerprints in one scan
//
// `errorsTimeseriesQuery` answers "how did this one fingerprint behave"; the
// unified errors list needs the same shape for every row it is about to draw,
// and one request per row would be 50 round trips. Rows come back tall
// (fingerprint x bucket) and are pivoted client-side — a wide `groupArray` of
// pairs would have to be re-sorted there anyway, since aggregate state merge
// order is not the input order.
//
// Fingerprint-filtered, so this rides `error_events`' (OrgId, FingerprintHash,
// Timestamp) key rather than scanning the window.

export interface ErrorsSparkOpts extends ErrorsSharedFilters {
	fingerprintHashes: readonly string[]
	/**
	 * Restrict to root-span occurrences, matching the list the spark is drawn
	 * beside. Unset — which is every caller that predates it — leaves the
	 * compiled SQL byte-identical; a trend that counts occurrences the row's own
	 * count excluded is a chart that contradicts the number next to it.
	 */
	rootOnly?: boolean
}

export const ErrorsSparkOutputSchema = Schema.Struct({
	fingerprintHash: Schema.String,
	bucket: Schema.String,
	count: CHNumber,
})
export type ErrorsSparkOutput = Schema.Schema.Type<typeof ErrorsSparkOutputSchema>

export function errorsSparkQuery(opts: ErrorsSparkOpts) {
	return from(ErrorEvents)
		.select(($) => ({
			// Identity UInt64: unwrapped it corrupts above 2^53.
			fingerprintHash: CH.toString_($.FingerprintHash),
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			fingerprintHashIn($.FingerprintHash, opts.fingerprintHashes),
			$.Timestamp.gte(param.dateTimeSeconds("startTime")),
			$.Timestamp.lte(param.dateTimeSeconds("endTime")),
			CH.whenTrue(!!opts.rootOnly, () => $.ParentSpanId.eq("")),
			...sharedFilterConditions($, opts),
		])
		.groupBy("fingerprintHash", "bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// Span hierarchy

/**
 * Span attribute keys the waterfall / timeline / flow views actually read
 * (via `getHttpInfo` + `getCacheInfo`). The hierarchy query projects only
 * these instead of the full `SpanAttributes` map — selecting the full map for
 * every span in a wide trace materializes hundreds of MB of JSON and blows the
 * query memory limit. The full map is loaded lazily per-span by `spanDetailQuery`.
 */
const TREE_SPAN_ATTR_KEYS = [
	"http.method",
	"http.request.method",
	"http.route",
	"url.full",
	"http.url",
	"server.address",
	"net.peer.name",
	"url.path",
	"http.target",
	"http.status_code",
	"http.response.status_code",
	"cache.system",
	"cache.result",
	"cache.name",
	"cache.operation",
	"cache.lookup_performed",
	// Generic OpenTelemetry database-client spans — the `db.system.name` signal
	// (with the legacy `db.system` fallback) lets the trace views detect a DB
	// span and render its summary badge without waiting for the per-span lazy
	// detail fetch. The full `db.*` field set (namespace, operation, rows,
	// server, …) is loaded lazily by `spanDetailQuery` for the detail panel.
	"db.system.name",
	"db.system",
	// Cloudflare Workers Observability — read by `getCloudflareInfo` to mark
	// Worker spans and render the edge-location + outcome badges in the tree
	// views. The full set (ray id, cpu/wall time, script version, geo city) is
	// lazy-loaded per-span by `spanDetailQuery` for the detail panel.
	"cloud.platform",
	"cloudflare.colo",
	"faas.invoked_region",
	"cloudflare.outcome",
] as const

/**
 * Resource attribute keys the trace-detail header reads (deployment env + commit).
 * Everything else in `ResourceAttributes` is loaded lazily by `spanDetailQuery`.
 */
const TREE_RESOURCE_ATTR_KEYS = ["deployment.environment", "vcs.ref.head.revision"] as const

/**
 * Hard cap on spans returned for one trace. A waterfall with more than a few
 * thousand rows is unrenderable, and pathological traces (hundreds of thousands
 * of spans) otherwise produce a response large enough to stall the API. The cap
 * keeps the earliest spans (ORDER BY StartTime ASC) so the root and its subtree
 * stay connected.
 */
export const SPAN_HIERARCHY_MAX_SPANS = 5_000

export interface SpanHierarchyOpts {
	traceId: string
	spanId?: string
	/** Override the default cap for callers that fetch one sentinel row. */
	limit?: number
	/**
	 * When true, the generated SQL adds `Timestamp BETWEEN startTime AND endTime`
	 * filters using parameter placeholders. Callers must then pass `startTime`
	 * and `endTime` to `compile()`. Without this, ClickHouse cannot prune
	 * partitions and scans the full retention window for the trace ID.
	 */
	narrowByTime?: boolean
}

export interface SpanHierarchyOutput {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
	readonly spanName: string
	readonly serviceName: string
	readonly spanKind: string
	readonly durationMs: number
	readonly startTime: string
	readonly statusCode: string
	readonly statusMessage: string
	readonly spanAttributes: string
	readonly resourceAttributes: string
	readonly relationship: string
}

export function spanHierarchyQuery(opts: SpanHierarchyOpts) {
	return (
		from(TraceDetailSpans)
			.select(($) => {
				// HTTP span name rewriting: "http.server GET" + route → "GET /api/users".
				// Shared with the materialized view and the trace-list span-name filter.
				const httpRewriteExpr = httpDisplaySpanName(
					$.SpanName,
					$.SpanAttributes.get("http.route"),
					$.SpanAttributes.get("url.path"),
				)

				const relationshipExpr = opts.spanId
					? CH.if_($.SpanId.eq(opts.spanId), CH.lit("target"), CH.lit("related"))
					: CH.lit("related")

				return {
					traceId: $.TraceId,
					spanId: $.SpanId,
					parentSpanId: $.ParentSpanId,
					spanName: httpRewriteExpr,
					serviceName: $.ServiceName,
					spanKind: $.SpanKind,
					durationMs: $.Duration.div(1000000),
					startTime: $.Timestamp,
					statusCode: $.StatusCode,
					statusMessage: $.StatusMessage,
					// Trimmed maps — only the keys the tree views render. Full maps are
					// fetched per-span on demand via spanDetailQuery.
					spanAttributes: CH.toJSONString(
						buildProjectedMapExpr(TREE_SPAN_ATTR_KEYS, "SpanAttributes"),
					),
					resourceAttributes: CH.toJSONString(
						buildProjectedMapExpr(TREE_RESOURCE_ATTR_KEYS, "ResourceAttributes"),
					),
					relationship: relationshipExpr,
				}
			})
			.where(($) => [
				$.TraceId.eq(opts.traceId),
				$.OrgId.eq(param.string("orgId")),
				CH.whenTrue(!!opts.narrowByTime, () => $.Timestamp.gte(param.dateTimeString("startTime"))),
				CH.whenTrue(!!opts.narrowByTime, () => $.Timestamp.lte(param.dateTimeString("endTime"))),
			])
			// ORDER BY + LIMIT bounds pathological traces — the earliest spans keep
			// the root subtree connected. buildSpanTree (web) re-sorts children anyway.
			.orderBy(["startTime", "asc"])
			.limit(opts.limit ?? SPAN_HIERARCHY_MAX_SPANS)
			.format("JSON")
	)
}

// Span detail — full attributes for a single span

export interface SpanDetailOpts {
	traceId: string
	spanId: string
	/**
	 * When true, adds `Timestamp BETWEEN startTime AND endTime` filters so
	 * ClickHouse can prune partitions. Callers must then pass `startTime` /
	 * `endTime` to `compile()`.
	 */
	narrowByTime?: boolean
}

export interface SpanDetailOutput {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
	readonly spanName: string
	readonly serviceName: string
	readonly spanKind: string
	readonly durationMs: number
	readonly startTime: string
	readonly statusCode: string
	readonly statusMessage: string
	readonly spanAttributes: string
	readonly resourceAttributes: string
}

/**
 * Point lookup for one span's full attribute maps. The sorting key
 * `(OrgId, TraceId, SpanId)` makes this an O(log N) lookup. Used by the trace
 * detail panel to lazily load the attributes the trimmed `spanHierarchyQuery`
 * intentionally omits.
 */
export function spanDetailQuery(opts: SpanDetailOpts) {
	return from(TraceDetailSpans)
		.select(($) => ({
			traceId: $.TraceId,
			spanId: $.SpanId,
			parentSpanId: $.ParentSpanId,
			spanName: httpDisplaySpanName(
				$.SpanName,
				$.SpanAttributes.get("http.route"),
				$.SpanAttributes.get("url.path"),
			),
			serviceName: $.ServiceName,
			spanKind: $.SpanKind,
			durationMs: $.Duration.div(1000000),
			startTime: $.Timestamp,
			statusCode: $.StatusCode,
			statusMessage: $.StatusMessage,
			spanAttributes: CH.toJSONString($.SpanAttributes),
			resourceAttributes: CH.toJSONString($.ResourceAttributes),
		}))
		.where(($) => [
			$.TraceId.eq(opts.traceId),
			$.SpanId.eq(opts.spanId),
			$.OrgId.eq(param.string("orgId")),
			CH.whenTrue(!!opts.narrowByTime, () => $.Timestamp.gte(param.dateTimeString("startTime"))),
			CH.whenTrue(!!opts.narrowByTime, () => $.Timestamp.lte(param.dateTimeString("endTime"))),
		])
		.limit(1)
		.format("JSON")
}

// Trace timestamp probe — resolve any one span timestamp for a trace

export interface TraceTimeProbeOutput {
	readonly timestamp: string
}

/**
 * Cheap timestamp resolver for a trace. `trace_detail_spans` is partitioned by
 * `toDate(Timestamp)`, so a trace lookup with no time predicate must seek across
 * every daily partition. When the caller has no timestamp (direct URL, shared
 * link, AI surface), this probe resolves one: selecting only `Timestamp`, with
 * no `ORDER BY` and `LIMIT 1`, ClickHouse reads ~one granule per partition and
 * stops — far cheaper than the full `spanHierarchyQuery` projection. The caller
 * then derives a ±1h window so the real query can prune partitions.
 *
 * Even the probe pays the every-partition seek when unbounded, so callers
 * should first try `narrowByTime: true` with a recent `startTime` lower bound
 * (pruning to the last few partitions) and only fall back to the unbounded
 * probe when the trace is older than that window.
 */
export function traceTimeProbeQuery(opts: { traceId: string; narrowByTime?: boolean }) {
	return from(TraceDetailSpans)
		.select(($) => ({ timestamp: $.Timestamp }))
		.where(($) => [
			$.TraceId.eq(opts.traceId),
			$.OrgId.eq(param.string("orgId")),
			CH.whenTrue(!!opts.narrowByTime, () => $.Timestamp.gte(param.dateTimeString("startTime"))),
		])
		.limit(1)
		.format("JSON")
}

// Traces duration stats and facets
//
// Both count root spans over the window. When `trace_facets_hourly` carries the
// filters, its whole hours answer the interior and `trace_list_mv` only the
// partial hour at each end (`rollup-splice`); otherwise `trace_list_mv` answers
// the whole window through the same union.

export interface TracesDurationStatsOpts {
	serviceName?: string
	spanName?: string
	hasError?: boolean
	minDurationMs?: number
	maxDurationMs?: number
	httpMethod?: string
	httpStatusCode?: string
	deploymentEnv?: string
	namespace?: string
	/**
	 * Multi-value spellings, compiled to `IN (...)` against trace_list_mv's
	 * pre-extracted columns. Each wins over its scalar counterpart when non-empty.
	 */
	serviceNames?: readonly string[]
	spanNames?: readonly string[]
	httpMethods?: readonly string[]
	httpStatusCodes?: readonly string[]
	deploymentEnvs?: readonly string[]
	namespaces?: readonly string[]
	matchModes?: {
		serviceName?: "contains"
		spanName?: "contains"
		deploymentEnv?: "contains"
		serviceNamespace?: "contains"
	}
	/**
	 * `ILIKE` patterns whose matching span names / routes are dropped — the
	 * sidebar's "Hide health checks". Kept in step with the list query's own
	 * `excludeNamePatterns` so a facet count describes the rows the list shows.
	 */
	excludeNamePatterns?: readonly string[]
	/** Read only `trace_list_mv`: for clusters that have not applied migration 0034. */
	rawOnly?: boolean
}

/** The facet dimensions, spelled the same on `trace_list_mv` and `trace_facets_hourly`. */
type TraceFacetColumns = Pick<
	typeof TraceListMv.columns,
	| "ServiceName"
	| "SpanName"
	| "HttpMethod"
	| "HttpStatusCode"
	| "DeploymentEnv"
	| "ServiceNamespace"
	| "HasError"
>

function traceFacetDimensionConditions(
	$: ColumnAccessor<TraceFacetColumns>,
	opts: TracesDurationStatsOpts,
): Array<CH.Condition | undefined> {
	const mm = opts.matchModes
	const services = inclusionValues(opts.serviceName, opts.serviceNames)
	const spanNames = inclusionValues(opts.spanName, opts.spanNames)
	const httpMethods = inclusionValues(opts.httpMethod, opts.httpMethods)
	const httpStatusCodes = inclusionValues(opts.httpStatusCode, opts.httpStatusCodes)
	const envs = inclusionValues(opts.deploymentEnv, opts.deploymentEnvs)
	const namespaces = inclusionValues(opts.namespace, opts.namespaces)

	return [
		CH.when(services, (v: readonly string[]) =>
			matchOrIn($.ServiceName, v, mm?.serviceName === "contains"),
		),
		CH.when(spanNames, (v: readonly string[]) => matchOrIn($.SpanName, v, mm?.spanName === "contains")),
		CH.whenTrue(!!opts.hasError, () => $.HasError.eq(1)),
		CH.when(httpMethods, (v: readonly string[]) => inclusionCondition($.HttpMethod, v)),
		CH.when(httpStatusCodes, (v: readonly string[]) => inclusionCondition($.HttpStatusCode, v)),
		// Through `envLabel` on both tiers, so selecting `unknown` matches the
		// untagged rows the facet offered under that name.
		CH.when(envs, (v: readonly string[]) =>
			matchOrIn(envLabel($.DeploymentEnv), v, mm?.deploymentEnv === "contains"),
		),
		CH.when(namespaces, (v: readonly string[]) =>
			matchOrIn($.ServiceNamespace, v, mm?.serviceNamespace === "contains"),
		),
	]
}

/**
 * Whether `trace_facets_hourly` can answer the whole-hour interior. It keeps the
 * facet dimensions and nothing finer, so a duration bound or an attribute
 * filter, which each need the individual root span, reads `trace_list_mv` for
 * the whole window. So does "Hide health checks": its patterns match the route
 * as well as the span name, and the rollup keeps no route.
 */
export function canUseTraceFacetsRollup(
	opts: TracesDurationStatsOpts & {
		readonly attributeFilterKey?: string
		readonly resourceFilterKey?: string
	},
): boolean {
	return (
		!opts.rawOnly &&
		opts.minDurationMs == null &&
		opts.maxDurationMs == null &&
		!opts.attributeFilterKey &&
		!opts.resourceFilterKey &&
		!opts.excludeNamePatterns?.length
	)
}

/** `trace_list_mv` rows in the window, narrowed to the partial end hours when the rollup has the rest. */
function traceListWindowConditions($: ColumnAccessor<typeof TraceListMv.columns>, opts: TracesFacetsOpts) {
	return [
		$.OrgId.eq(param.string("orgId")),
		$.Timestamp.gte(param.dateTimeSeconds("startTime")),
		$.Timestamp.lte(param.dateTimeSeconds("endTime")),
		...traceFacetDimensionConditions($, opts),
		CH.when(opts.minDurationMs, (v: number) => $.Duration.gte(v * 1000000)),
		CH.when(opts.maxDurationMs, (v: number) => $.Duration.lte(v * 1000000)),
		nameExclusionCondition(opts.excludeNamePatterns, $.SpanName, $.HttpRoute),
		CH.whenTrue(canUseTraceFacetsRollup(opts), () => edgeCondition("Timestamp")),
	]
}

function traceFacetsHourlyInteriorConditions(
	$: ColumnAccessor<typeof TraceFacetsHourly.columns>,
	opts: TracesDurationStatsOpts,
) {
	return [
		$.OrgId.eq(param.string("orgId")),
		...interiorConditions($.Hour),
		...traceFacetDimensionConditions($, opts),
	]
}

/** The raw tier, plus the hourly interior when the rollup can answer it. */
function traceFacetTiers<Output extends Record<string, unknown>>(
	opts: TracesFacetsOpts,
	raw: CHQuery<ColumnDefs, Output, {}>,
	hourly: () => CHQuery<ColumnDefs, Output, {}>,
): CHUnionQuery<Output> {
	return canUseTraceFacetsRollup(opts) ? unionAll(raw, hourly()) : unionAll(raw)
}

export interface TracesDurationStatsOutput {
	readonly minDurationMs: number
	readonly maxDurationMs: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
}

export function tracesDurationStatsQuery(
	opts: TracesDurationStatsOpts,
): CHQuery<ColumnDefs, TracesDurationStatsOutput, {}> {
	// Each tier reports its row count beside its extremes: an aggregate over an
	// empty tier returns 0 rather than nothing, and that 0 must not win the
	// outer `min`. The t-digest states merge across tiers; an empty one is inert.
	const raw = from(TraceListMv)
		.select(($) => ({
			traceCount: CH.count(),
			durationMin: CH.min_($.Duration),
			durationMax: CH.max_($.Duration),
			durationQuantiles: CH.rawExpr("quantilesTDigestState(0.5, 0.95)(Duration)", T.string),
		}))
		.where(($) => traceListWindowConditions($, opts))
	const hourly = () =>
		from(TraceFacetsHourly)
			.select(($) => ({
				traceCount: CH.sum($.TraceCount),
				durationMin: CH.min_($.DurationMin),
				durationMax: CH.max_($.DurationMax),
				durationQuantiles: CH.rawExpr(
					"quantilesTDigestMergeState(0.5, 0.95)(DurationQuantiles)",
					T.string,
				),
			}))
			.where(($) => traceFacetsHourlyInteriorConditions($, opts))

	const quantiles = "quantilesTDigestMerge(0.5, 0.95)(durationQuantiles)"
	return fromUnion(traceFacetTiers(opts, raw, hourly), "duration_tiers")
		.select(() => ({
			minDurationMs: CH.rawExpr("minIf(durationMin, traceCount > 0) / 1000000", T.float64),
			maxDurationMs: CH.rawExpr("maxIf(durationMax, traceCount > 0) / 1000000", T.float64),
			p50DurationMs: finiteOrZero(CH.rawExpr(`arrayElement(${quantiles}, 1) / 1000000`, T.float64)),
			p95DurationMs: finiteOrZero(CH.rawExpr(`arrayElement(${quantiles}, 2) / 1000000`, T.float64)),
		}))
		.format("JSON")
}

// Traces facets (UNION ALL — 6 facet dimensions and the error count)

export type TracesFacetDimension =
	| "service"
	| "spanName"
	| "httpMethod"
	| "httpStatus"
	| "deploymentEnv"
	| "serviceNamespace"

export interface TracesFacetsOpts extends TracesDurationStatsOpts {
	attributeFilterKey?: string
	attributeFilterValue?: string
	attributeFilterValueMatchMode?: "contains"
	resourceFilterKey?: string
	resourceFilterValue?: string
	resourceFilterValueMatchMode?: "contains"
	/** When set, compile only this dimension's UNION branch (single-list consumers). */
	facet?: TracesFacetDimension
}

export type TracesFacetsOutput = FacetOutput

/** The String-typed columns of a table — a facet name is one of those, and a
 *  facet over a `UInt64` would be a number in a field the wire calls a string. */
type StringColumn<Cols extends ColumnDefs> = {
	[K in keyof Cols & string]: Cols[K] extends T.CHString ? K : never
}[keyof Cols & string]

export function tracesFacetsQuery(opts: TracesFacetsOpts): CHUnionQuery<TracesFacetsOutput> {
	const rawWhere = ($: ColumnAccessor<typeof TraceListMv.columns>): Array<CH.Condition | undefined> => {
		const conditions: Array<CH.Condition | undefined> = traceListWindowConditions($, opts)

		// Attribute filter EXISTS subqueries (correlated — references outer TraceId)
		if (opts.attributeFilterKey) {
			const attrCol = CH.mapGet(
				CH.dynamicColumn<Record<string, string>>("t_attr.SpanAttributes"),
				opts.attributeFilterKey,
			)
			const matchCond =
				opts.attributeFilterValueMatchMode === "contains"
					? CH.positionCaseInsensitive(attrCol, CH.lit(opts.attributeFilterValue ?? "")).gt(0)
					: attrCol.eq(opts.attributeFilterValue ?? "")
			conditions.push(
				exists(
					from(Traces, "t_attr")
						.select(() => ({ _: CH.lit(1) }))
						.where(() => [
							CH.dynamicColumn("t_attr.TraceId").eq(CH.outerRef("TraceId")),
							CH.dynamicColumn("t_attr.OrgId").eq(param.string("orgId")),
							CH.dynamicColumn<string>("t_attr.Timestamp").gte(
								param.dateTimeString("startTime"),
							),
							CH.dynamicColumn<string>("t_attr.Timestamp").lte(param.dateTimeString("endTime")),
							matchCond,
						]),
				),
			)
		}
		if (opts.resourceFilterKey) {
			const resCol = CH.mapGet(
				CH.dynamicColumn<Record<string, string>>("t_res.ResourceAttributes"),
				opts.resourceFilterKey,
			)
			const matchCond =
				opts.resourceFilterValueMatchMode === "contains"
					? CH.positionCaseInsensitive(resCol, CH.lit(opts.resourceFilterValue ?? "")).gt(0)
					: resCol.eq(opts.resourceFilterValue ?? "")
			conditions.push(
				exists(
					from(Traces, "t_res")
						.select(() => ({ _: CH.lit(1) }))
						.where(() => [
							CH.dynamicColumn("t_res.TraceId").eq(CH.outerRef("TraceId")),
							CH.dynamicColumn("t_res.OrgId").eq(param.string("orgId")),
							CH.dynamicColumn<string>("t_res.Timestamp").gte(
								param.dateTimeString("startTime"),
							),
							CH.dynamicColumn<string>("t_res.Timestamp").lte(param.dateTimeString("endTime")),
							matchCond,
						]),
				),
			)
		}

		return conditions
	}

	// `colName` is a real column of both tiers, so the accessor already knows how
	// it decodes — naming it as a `dynamicColumn` threw that away and cost every
	// facet branch its row schema.
	const makeFacetQuery = (
		colName: StringColumn<typeof TraceListMv.columns> & StringColumn<typeof TraceFacetsHourly.columns>,
		facetType: string,
		dropEmpty: boolean,
		limit = 50,
		// Applied to the column on both tiers; the environment branch passes
		// `envLabel` so an untagged span is offered as `unknown`.
		label: (column: CH.Expr<string>) => CH.Expr<string> = (column) => column,
	) => {
		const raw = from(TraceListMv)
			.select(($) => ({ name: label($[colName]), count: CH.count() }))
			.where(($) => [...rawWhere($), CH.whenTrue(dropEmpty, () => $[colName].neq(""))])
			.groupBy("name")
		const hourly = () =>
			from(TraceFacetsHourly)
				.select(($) => ({ name: label($[colName]), count: CH.sum($.TraceCount) }))
				.where(($) => [
					...traceFacetsHourlyInteriorConditions($, opts),
					CH.whenTrue(dropEmpty, () => $[colName].neq("")),
				])
				.groupBy("name")
		return fromUnion(traceFacetTiers(opts, raw, hourly), `${facetType}_tiers`)
			.select(($) => ({
				name: $.name,
				count: CH.sum($.count),
				facetType: CH.lit(facetType),
			}))
			.groupBy("name")
			.orderBy(["count", "desc"])
			.limit(limit)
	}

	const errorCountQuery = () => {
		const raw = from(TraceListMv)
			.select(() => ({ count: CH.count() }))
			.where(($) => [...rawWhere($), $.HasError.eq(1)])
		const hourly = () =>
			from(TraceFacetsHourly)
				.select(($) => ({ count: CH.sum($.TraceCount) }))
				.where(($) => [...traceFacetsHourlyInteriorConditions($, opts), $.HasError.eq(1)])
		return fromUnion(traceFacetTiers(opts, raw, hourly), "errorCount_tiers").select(($) => ({
			name: CH.lit("error"),
			count: CH.sum($.count),
			facetType: CH.lit("errorCount"),
		}))
	}

	const facetBranches = {
		service: () => makeFacetQuery("ServiceName", "service", false),
		spanName: () => makeFacetQuery("SpanName", "spanName", true, 20),
		httpMethod: () => makeFacetQuery("HttpMethod", "httpMethod", true, 20),
		httpStatus: () => makeFacetQuery("HttpStatusCode", "httpStatus", true, 20),
		deploymentEnv: () => makeFacetQuery("DeploymentEnv", "deploymentEnv", false, 20, envLabel),
		serviceNamespace: () => makeFacetQuery("ServiceNamespace", "serviceNamespace", true, 20),
	} satisfies Record<TracesFacetDimension, () => ReturnType<typeof makeFacetQuery>>

	if (opts.facet) {
		return unionAll(facetBranches[opts.facet]()).format("JSON")
	}

	return unionAll(
		facetBranches.service(),
		facetBranches.spanName(),
		facetBranches.httpMethod(),
		facetBranches.httpStatus(),
		facetBranches.deploymentEnv(),
		facetBranches.serviceNamespace(),
		errorCountQuery(),
	).format("JSON")
}

// Errors facets (UNION ALL — service + environment + error_type facets)

export interface ErrorsFacetsOpts extends ErrorsSharedFilters {
	rootOnly?: boolean
	fingerprintHashes?: readonly string[]
}

export type ErrorsFacetsOutput = FacetOutput

export function errorsFacetsQuery(opts: ErrorsFacetsOpts): CHUnionQuery<ErrorsFacetsOutput> {
	const table = errorEventsTableForRecentScan(opts)
	const baseWhere =
		(except: ErrorsFilterDimension) =>
		($: ColumnAccessor<typeof table.columns>): Array<CH.Condition | undefined> => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeSeconds("startTime")),
			$.Timestamp.lte(param.dateTimeSeconds("endTime")),
			CH.whenTrue(!!opts.rootOnly, () => $.ParentSpanId.eq("")),
			...sharedFilterConditions($, opts, except),
			opts.fingerprintHashes?.length
				? fingerprintHashIn($.FingerprintHash, opts.fingerprintHashes)
				: undefined,
		]

	/**
	 * A facet counts ISSUES, not occurrences.
	 *
	 * The sidebar filters a list of issue rows, so the number beside an option
	 * has to be the number of rows ticking it yields. `count()` reported
	 * occurrences instead: one runaway dev CLI loop read 183.1K next to a list of
	 * a dozen issues, and no two numbers on the page could be reconciled.
	 */
	const issueCount = ($: ColumnAccessor<typeof table.columns>) => CH.uniq($.FingerprintHash)

	const serviceQuery = from(table)
		.select(($) => ({
			name: $.ServiceName,
			count: issueCount($),
			facetType: CH.lit("service"),
		}))
		.where(baseWhere("services"))
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(100)

	const envQuery = from(table)
		.select(($) => ({
			name: envLabel($.DeploymentEnv),
			count: issueCount($),
			facetType: CH.lit("environment"),
		}))
		.where(baseWhere("deploymentEnvs"))
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(100)

	// error_type facet groups by the human-readable ErrorLabel (display facet).
	const errorTypeQuery = from(table)
		.select(($) => ({
			name: $.ErrorLabel,
			count: issueCount($),
			facetType: CH.lit("error_type"),
		}))
		.where(baseWhere("errorLabels"))
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(50)

	// Deployed version the error was seen on — the fastest way to tell a
	// regression from something that was always broken. Blank versions are
	// dropped: a facet you cannot act on is noise.
	const versionQuery = from(table)
		.select(($) => ({
			name: $.ServiceVersion,
			count: issueCount($),
			facetType: CH.lit("version"),
		}))
		.where(($) => [...baseWhere("serviceVersions")($), $.ServiceVersion.neq("")])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(50)

	return unionAll(serviceQuery, envQuery, errorTypeQuery, versionQuery).format("JSON")
}

// Errors summary (CROSS JOIN between the error-events table and service_usage)

export interface ErrorsSummaryOpts extends ErrorsSharedFilters {
	rootOnly?: boolean
	fingerprintHashes?: readonly string[]
}

export interface ErrorsSummaryOutput {
	readonly totalErrors: number
	readonly totalSpans: number
	readonly errorRate: number
	readonly affectedServicesCount: number
	readonly affectedTracesCount: number
}

export function errorsSummaryQuery(opts: ErrorsSummaryOpts) {
	const errorSub = from(errorEventsTableForRecentScan(opts))
		.select(($) => ({
			totalErrors: CH.count(),
			affectedServicesCount: CH.uniq($.ServiceName),
			affectedTracesCount: CH.uniq($.TraceId),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeSeconds("startTime")),
			$.Timestamp.lte(param.dateTimeSeconds("endTime")),
			CH.whenTrue(!!opts.rootOnly, () => $.ParentSpanId.eq("")),
			...sharedFilterConditions($, opts),
			opts.fingerprintHashes?.length
				? fingerprintHashIn($.FingerprintHash, opts.fingerprintHashes)
				: undefined,
		])

	const buildResult = <JCols extends ColumnDefs, JJoins extends Record<string, ColumnDefs>>(
		usageSub: CHQuery<JCols, { totalSpans: number }, JJoins>,
	) =>
		fromQuery(errorSub, "e")
			.crossJoinQuery(usageSub, "s")
			.select(($) => ({
				totalErrors: $.totalErrors,
				totalSpans: $.s.totalSpans,
				errorRate: finiteOrZero(CH.round_($.totalErrors.div($.s.totalSpans), 6)),
				affectedServicesCount: $.affectedServicesCount,
				affectedTracesCount: $.affectedTracesCount,
			}))
			.format("JSON")

	if (opts.rootOnly) {
		return buildResult(
			from(TraceListMv)
				.select(() => ({
					totalSpans: CH.count(),
				}))
				.where(($) => [
					$.OrgId.eq(param.string("orgId")),
					$.Timestamp.gte(param.dateTimeSeconds("startTime")),
					$.Timestamp.lte(param.dateTimeSeconds("endTime")),
					opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
					opts.deploymentEnvs?.length
						? CH.inList(envLabel($.DeploymentEnv), opts.deploymentEnvs)
						: undefined,
				]),
		)
	}

	if (opts.deploymentEnvs?.length) {
		const deploymentEnvs = opts.deploymentEnvs
		return buildResult(
			from(Traces)
				.select(() => ({
					totalSpans: CH.count(),
				}))
				.where(($) => [
					$.OrgId.eq(param.string("orgId")),
					$.Timestamp.gte(param.dateTimeString("startTime")),
					$.Timestamp.lte(param.dateTimeString("endTime")),
					opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
					CH.inList(resourceEnvLabel($.ResourceAttributes), deploymentEnvs),
				]),
		)
	}

	// The hourly usage rollup only answers whole hours inside the window; the
	// partial hours at each end come from raw spans. Reading the rollup alone
	// made any window shorter than an hour report 0 spans and a 0% error rate.
	const wholeHours = from(ServiceUsage)
		.select(($) => ({
			bucketSpans: CH.sum($.TraceCount),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			...interiorConditions($.Hour),
			opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
		])
	const partialHours = from(Traces)
		.select(() => ({
			bucketSpans: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
			edgeCondition("Timestamp"),
			opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
		])
	return buildResult(
		fromUnion(unionAll(wholeHours, partialHours), "usage").select(($) => ({
			totalSpans: CH.sum($.bucketSpans),
		})),
	)
}

// Error Issues — fingerprint-grouped aggregate from error_events

export interface ErrorIssuesOpts {
	services?: readonly string[]
	deploymentEnvs?: readonly string[]
	fingerprintHashes?: readonly string[]
	exceptionTypes?: readonly string[]
	limit?: number
}

export interface ErrorIssuesOutput {
	readonly fingerprintHash: string
	readonly serviceName: string
	readonly exceptionType: string
	readonly exceptionMessage: string
	readonly errorLabel: string
	readonly topFrame: string
	readonly count: number
	readonly affectedServicesCount: number
	readonly firstSeen: string
	readonly lastSeen: string
}

export function errorIssuesQuery(opts: ErrorIssuesOpts) {
	// Broad issue scans use the time-ordered sibling so ClickHouse prunes by
	// (OrgId, Timestamp). When the caller narrows to known fingerprints, switch
	// back to the FingerprintHash-ordered table.
	return from(errorEventsTableForRecentScan(opts))
		.select(($) => ({
			fingerprintHash: CH.toString_($.FingerprintHash),
			serviceName: CH.any_($.ServiceName),
			exceptionType: CH.any_($.ExceptionType),
			exceptionMessage: CH.any_($.ExceptionMessage),
			errorLabel: CH.any_($.ErrorLabel),
			topFrame: CH.any_($.TopFrame),
			count: CH.count(),
			affectedServicesCount: CH.uniq($.ServiceName),
			firstSeen: CH.min_($.Timestamp),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeSeconds("startTime")),
			$.Timestamp.lte(param.dateTimeSeconds("endTime")),
			opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
			opts.deploymentEnvs?.length
				? CH.inList(envLabel($.DeploymentEnv), opts.deploymentEnvs)
				: undefined,
			opts.fingerprintHashes?.length
				? fingerprintHashIn($.FingerprintHash, opts.fingerprintHashes)
				: undefined,
			opts.exceptionTypes?.length ? CH.inList($.ExceptionType, opts.exceptionTypes) : undefined,
		])
		.groupBy("fingerprintHash")
		.orderBy(["count", "desc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

/**
 * Error groups observed in one or more completed minute buckets. Unlike the UI
 * issue query, this intentionally has no LIMIT: the durable Postgres cursor may
 * advance only after every fingerprint in the claimed half-open window commits.
 */
export function errorTickIssuesQuery() {
	return from(ErrorFingerprintsMinutely)
		.select(($) => ({
			fingerprintHash: CH.toString_($.FingerprintHash),
			serviceName: CH.any_($.ServiceName),
			exceptionType: CH.any_($.ExceptionType),
			exceptionMessage: CH.any_($.ExceptionMessage),
			errorLabel: CH.any_($.ErrorLabel),
			topFrame: CH.any_($.TopFrame),
			// Every build seen in the window, not one sampled build — the issue's
			// build set is what separates a real regression from an old client.
			serviceVersions: CH.groupUniqArrayArray($.ServiceVersions),
			count: CH.sum($.OccurrenceCount),
			firstSeen: CH.min_($.FirstSeen),
			lastSeen: CH.max_($.LastSeen),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Minute.gte(param.dateTimeSeconds("startTime")),
			$.Minute.lt(param.dateTimeSeconds("endTime")),
		])
		.groupBy("fingerprintHash")
		.format("JSON")
}

/**
 * One-time cursor bootstrap against the existing per-occurrence projection.
 * Incremental materialized views do not backfill historical rows, so a newly
 * deployed evaluator uses this query for its initial two-minute window only.
 */
export function errorTickBootstrapIssuesQuery() {
	return from(ErrorEventsByTime)
		.select(($) => ({
			fingerprintHash: CH.toString_($.FingerprintHash),
			serviceName: CH.any_($.ServiceName),
			exceptionType: CH.any_($.ExceptionType),
			exceptionMessage: CH.any_($.ExceptionMessage),
			errorLabel: CH.any_($.ErrorLabel),
			topFrame: CH.any_($.TopFrame),
			// Per-occurrence rows here, so the distinct set comes straight from the
			// scalar column rather than from a pre-aggregated one.
			serviceVersions: CH.groupUniqArray($.ServiceVersion),
			count: CH.count(),
			firstSeen: CH.min_($.Timestamp),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeSeconds("startTime")),
			$.Timestamp.lt(param.dateTimeSeconds("endTime")),
		])
		.groupBy("fingerprintHash")
		.format("JSON")
}

// Error fingerprints — distinct fingerprint hashes observed in a scope

export interface ErrorFingerprintsOpts {
	services?: readonly string[]
	deploymentEnvs?: readonly string[]
	limit?: number
}

export interface ErrorFingerprintsOutput {
	readonly fingerprintHash: string
}

/**
 * The distinct error fingerprints seen for a service/environment scope in a
 * window. Backs the issue list's deployment-environment filter: the Postgres
 * `error_issues` rows carry no environment (a fingerprint spans environments),
 * so the filter intersects against the fingerprints the warehouse actually
 * observed in the selected environment.
 */
export function errorFingerprintsQuery(opts: ErrorFingerprintsOpts) {
	return from(ErrorEventsByTime)
		.select(($) => ({
			fingerprintHash: CH.toString_($.FingerprintHash),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeSeconds("startTime")),
			$.Timestamp.lte(param.dateTimeSeconds("endTime")),
			opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
			opts.deploymentEnvs?.length
				? CH.inList(envLabel($.DeploymentEnv), opts.deploymentEnvs)
				: undefined,
		])
		.groupBy("fingerprintHash")
		.limit(opts.limit ?? 1000)
		.format("JSON")
}

// Error Issue timeseries — per-fingerprint occurrence bucket

export interface ErrorIssueTimeseriesOutput {
	readonly bucket: string
	readonly count: number
}

export function errorIssueTimeseriesQuery() {
	return from(ErrorEvents)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.FingerprintHash.eq(CH.toUInt64(param.string("fingerprintHash"))),
			$.Timestamp.gte(param.dateTimeSeconds("startTime")),
			$.Timestamp.lte(param.dateTimeSeconds("endTime")),
		])
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// Error Issue sample traces — most recent occurrences for one issue

/** `TraceId`/`SpanId` brands come off `ErrorEvents`' branded columns — the
 *  derived row schema carries them, so no declared schema is needed. */
export interface ErrorIssueSampleTracesOutput {
	readonly traceId: TraceId
	readonly spanId: SpanId
	readonly serviceName: string
	readonly timestamp: string
	readonly exceptionMessage: string
	readonly durationMicros: number
}

export function errorIssueSampleTracesQuery(opts: { limit?: number }) {
	return from(ErrorEvents)
		.select(($) => ({
			traceId: $.TraceId,
			spanId: $.SpanId,
			serviceName: $.ServiceName,
			timestamp: $.Timestamp,
			exceptionMessage: $.ExceptionMessage,
			durationMicros: CH.intDiv($.Duration, 1000),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.FingerprintHash.eq(CH.toUInt64(param.string("fingerprintHash"))),
			$.Timestamp.gte(param.dateTimeSeconds("startTime")),
			$.Timestamp.lte(param.dateTimeSeconds("endTime")),
		])
		.orderBy(["timestamp", "desc"])
		.limit(opts.limit ?? 25)
		.format("JSON")
}

// Fix verification — occurrences of one fingerprint since a merge, per build.
//
// The verdict on "did the fix work" is a membership question, not a count: an
// occurrence from a build that was already running when the fix merged is an old
// client still in the wild, while one from a build absent from that set is the
// fix demonstrably not working. So this returns the split by `ServiceVersion`
// and lets the caller partition it against the merge-time baseline, rather than
// pushing the baseline array down into the SQL — which would have to be
// re-templated per issue and would defeat the compiled query's parameter reuse.
//
// Reads the per-occurrence table, not the minutely rollup: verification windows
// start at an arbitrary instant (the merge), and a minute-granular rollup would
// smear occurrences across the boundary in exactly the direction that matters.

export const ErrorIssueVersionsSinceOutputSchema = Schema.Struct({
	serviceVersion: Schema.String,
	count: CHNumber,
})
export type ErrorIssueVersionsSinceOutput = Schema.Schema.Type<typeof ErrorIssueVersionsSinceOutputSchema>

export function errorIssueVersionsSinceQuery(opts: { limit?: number } = {}) {
	return (
		from(ErrorEvents)
			.select(($) => ({
				serviceVersion: $.ServiceVersion,
				count: CH.count(),
			}))
			.where(($) => [
				$.OrgId.eq(param.string("orgId")),
				$.FingerprintHash.eq(CH.toUInt64(param.string("fingerprintHash"))),
				$.Timestamp.gte(param.dateTimeSeconds("startTime")),
				$.Timestamp.lte(param.dateTimeSeconds("endTime")),
			])
			.groupBy("serviceVersion")
			.orderBy(["count", "desc"])
			// Capped because an org running many builds could otherwise return a long
			// tail; the partition only needs the builds that actually fired, and the
			// count that matters is dominated by the head.
			.limit(opts.limit ?? 100)
			.format("JSON")
	)
}

export function errorIssueEnvironmentsQuery(opts: { limit?: number } = {}) {
	return from(ErrorEvents)
		.select(($) => ({
			name: envLabel($.DeploymentEnv),
			count: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.FingerprintHash.eq(CH.toUInt64(param.string("fingerprintHash"))),
			$.Timestamp.gte(param.dateTimeSeconds("startTime")),
			$.Timestamp.lte(param.dateTimeSeconds("endTime")),
		])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(opts.limit ?? 20)
		.format("JSON")
}

// Error → sessions
//
// The Errors page can already answer "which traces did this error happen in".
// For an error a person hit in a browser that is the wrong unit: what the
// reader wants is the recording — what the user was doing in the ten seconds
// before the throw, and what the page looked like after it.
//
// **Two ways in, because the data has two.** `session_events` rows of
// `Type = 'error'` are what the browser SDK's `installErrorCapture` writes
// (`capture/errors.ts`), and they carry `traceId: activeTraceId()` — which is
// the id of whatever span happened to be open. For an uncaught throw in an
// event handler that is usually nothing at all, so a trace-id join alone finds
// nothing for exactly the errors this feature exists for. The message is what
// is always there.
//
// Conversely the trace id is the only link for a *server* error the session
// caused: the browser's `network` event for the failed fetch carries the trace
// id the API answered under, and its message is an HTTP status, not a stack. So
// the predicate is the union — trace id OR message — and neither branch is
// redundant.
//
// Matching is `positionCaseInsensitive`, not `ILIKE '%…%'`: the needle is an
// exception message off a real exception, and messages contain `%` and `_`
// often enough (`"500 Internal Server Error"`, `"user_id missing"`) that LIKE's
// wildcards would quietly widen the match to something the page then presents
// as exact.

/** Distinct traces scanned for the trace-id branch. A fingerprint with more occurrences than this is not short of sessions to show. */
const ERROR_SESSION_TRACE_LIMIT = 500

/** Needle cap. A stack-sized needle is a slow scan and a worse match than its first line. */
const ERROR_SESSION_NEEDLE_MAX = 200

export interface ErrorSessionsOpts {
	fingerprintHash: string
	/**
	 * The fingerprint's own exception message (or type, when it has no message) —
	 * the browser-side branch of the match. Omit and only the trace-id branch
	 * runs, which is the right call when the text is empty or generic.
	 */
	messageMatch?: string
	limit?: number
}

export interface ErrorSessionsOutput {
	readonly sessionId: string
	/** `''` when no `session_replays` meta row arrived for the session. */
	readonly browserName: string
	readonly osName: string
	readonly deviceType: string
	readonly startTime: string
	/** Every error in the session, not just this fingerprint's. */
	readonly errorCount: number
	/** Events of this session that matched this fingerprint. */
	readonly matchCount: number
	/** `Seq` of the FIRST match — what a `?jump=` lands the replay player on. */
	readonly jumpSeq: number
	readonly lastMatchAt: string
}

export function errorSessionsQuery(opts: ErrorSessionsOpts) {
	const needle = opts.messageMatch?.trim().slice(0, ERROR_SESSION_NEEDLE_MAX)

	const errorTraces = from(ErrorEvents)
		.select(($) => ({ TraceId: $.TraceId }))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			// The list helper, not `fingerprintHashEq`: a synthetic alert/integration
			// key lowers to `1 = 0` instead of aborting on `toUInt64('alert:…')`.
			fingerprintHashIn($.FingerprintHash, [opts.fingerprintHash]),
			$.Timestamp.gte(param.dateTimeSeconds("startTime")),
			$.Timestamp.lte(param.dateTimeSeconds("endTime")),
			// An empty trace id would match every session event that has none.
			// Through `length()`, because `TraceId`'s branded schema refuses `''` as
			// a literal — which is the point of the brand, and exactly the value that
			// has to be excluded here.
			CH.length_($.TraceId).gt(0),
		])
		.groupBy("TraceId")
		.limit(ERROR_SESSION_TRACE_LIMIT)

	const matched = from(SessionEvents)
		.select(($) => ({
			sessionId: $.SessionId,
			matchCount: CH.count(),
			// The first match, not the last: a reader opening a session wants the
			// moment it broke, and everything after it is consequence.
			jumpSeq: CH.argMin($.Seq, $.Timestamp),
			lastMatchAt: CH.max_($.Timestamp),
		}))
		.where(($) => {
			const byTrace = inSubquery(
				$.TraceId,
				fromQuery(errorTraces, "error_traces").select(($$) => ({ TraceId: $$.TraceId })),
			)
			const byMessage = needle
				? $.Type.eq("error").and(
						CH.positionCaseInsensitive($.Message, CH.lit(needle))
							.gt(0)
							.or(CH.positionCaseInsensitive($.ErrorStack, CH.lit(needle)).gt(0)),
					)
				: undefined
			return [
				$.OrgId.eq(param.string("orgId")),
				$.Timestamp.gte(param.dateTimeString("startTime")),
				$.Timestamp.lte(param.dateTimeString("endTime")),
				byMessage ? byTrace.or(byMessage) : byTrace,
			]
		})
		.groupBy("sessionId")

	// Session metadata, finalized off the ReplacingMergeTree's `Version` like
	// every other read of this table.
	//
	// Bounded above and NOT below: a session that started yesterday and threw
	// inside the selected hour is precisely the row this query exists to return,
	// and a lower bound on StartTime would drop it. The upper bound still prunes
	// forward partitions, and the table is TTL'd at 30 days — this is the right
	// query for a store that holds an afternoon, which is what Local is.
	const sessions = from(SessionReplays)
		.select(($) => ({
			sessionId: $.SessionId,
			startTime: CH.argMax($.StartTime, $.Version),
			browserName: CH.argMax($.BrowserName, $.Version),
			osName: CH.argMax($.OsName, $.Version),
			deviceType: CH.argMax($.DeviceType, $.Version),
			errorCount: CH.argMax($.ErrorCount, $.Version),
		}))
		.where(($) => [$.OrgId.eq(param.string("orgId")), $.StartTime.lte(param.dateTimeString("endTime"))])
		.groupBy("sessionId")

	// LEFT, so a session whose meta row never arrived (a tab closed before the
	// unload beacon) still lists with the events that prove it happened, rather
	// than vanishing from an answer about its own error.
	return fromQuery(matched, "m")
		.leftJoinQuery(sessions, "s", (m, s) => m.sessionId.eq(s.sessionId))
		.select(($) => ({
			sessionId: $.sessionId,
			browserName: $.s.browserName,
			osName: $.s.osName,
			deviceType: $.s.deviceType,
			startTime: $.s.startTime,
			errorCount: $.s.errorCount,
			matchCount: $.matchCount,
			jumpSeq: $.jumpSeq,
			lastMatchAt: $.lastMatchAt,
		}))
		.orderBy(["lastMatchAt", "desc"])
		.limit(opts.limit ?? 10)
		.format("JSON")
}

// Error detail traces (INNER JOIN with error subquery)

export interface ErrorDetailTracesOpts {
	fingerprintHash: string
	rootOnly?: boolean
	services?: readonly string[]
	deploymentEnvs?: readonly string[]
	limit?: number
}

export interface ErrorDetailTracesOutput {
	readonly traceId: string
	readonly startTime: string
	readonly durationMicros: number
	readonly spanCount: number
	readonly services: readonly string[]
	readonly rootSpanName: string
	readonly errorMessage: string
	readonly errorSpanId: string
	readonly errorSpanName: string
	readonly errorServiceName: string
	readonly errorModel: string
	readonly errorToolName: string
	readonly errorHttpMethod: string
	readonly errorHttpRoute: string
	readonly errorQueryContext: string
	readonly errorType: string
	/** The fingerprint's own occurrence in this trace, as `error_events` recorded it. */
	readonly errorLabel: string
	readonly exceptionType: string
	readonly exceptionMessage: string
}

export function errorDetailTracesQuery(opts: ErrorDetailTracesOpts) {
	const limit = opts.limit ?? 10

	// One row per matching trace, ranked by its most recent occurrence so the
	// LIMIT keeps the N most recently errored traces. Each row names the span
	// that occurrence belongs to: a trace usually carries other failing spans
	// (the callers the error propagated through), and those are not this error.
	const occurrences = from(ErrorEvents)
		.select(($) => ({
			TraceId: $.TraceId,
			lastErrorSeen: CH.max_($.Timestamp),
			occurrenceSpanId: CH.argMax($.SpanId, $.Timestamp),
			occurrenceLabel: CH.argMax($.ErrorLabel, $.Timestamp),
			occurrenceExceptionType: CH.argMax($.ExceptionType, $.Timestamp),
			occurrenceExceptionMessage: CH.argMax($.ExceptionMessage, $.Timestamp),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			fingerprintHashEq($.FingerprintHash, opts.fingerprintHash),
			$.Timestamp.gte(param.dateTimeSeconds("startTime")),
			$.Timestamp.lte(param.dateTimeSeconds("endTime")),
			CH.whenTrue(!!opts.rootOnly, () => $.ParentSpanId.eq("")),
			opts.services?.length ? CH.inList($.ServiceName, opts.services) : undefined,
			opts.deploymentEnvs?.length ? CH.inList($.DeploymentEnv, opts.deploymentEnvs) : undefined,
		])
		.groupBy("TraceId")
		// The TraceId tiebreak keeps both reads of this subquery (the IN set and
		// the join) on the same traces when occurrences share a second.
		.orderBy(["lastErrorSeen", "desc"], ["TraceId", "desc"])
		.limit(limit)

	// The `IN` filter is what bounds the `trace_detail_spans` read to these
	// traces through its `(OrgId, TraceId, SpanId)` sort key; the join only
	// carries each trace's occurrence span id across to pick the error span.
	return from(TraceDetailSpans)
		.innerJoinQuery(occurrences, "occurrence", (span, occurrence) => span.TraceId.eq(occurrence.TraceId))
		.select(($) => {
			const isOccurrence = $.SpanId.eq($.occurrence.occurrenceSpanId)
			return {
				traceId: $.TraceId,
				startTime: CH.min_($.Timestamp),
				durationMicros: CH.intDiv(CH.max_($.Duration), 1000),
				spanCount: CH.count(),
				services: CH.groupUniqArray($.ServiceName),
				rootSpanName: CH.anyIf($.SpanName, $.ParentSpanId.eq("")),
				errorMessage: CH.anyIf($.StatusMessage, isOccurrence),
				errorSpanId: CH.anyIf($.SpanId, isOccurrence),
				errorSpanName: CH.anyIf($.SpanName, isOccurrence),
				errorServiceName: CH.anyIf($.ServiceName, isOccurrence),
				errorModel: CH.anyIf($.SpanAttributes.get("gen_ai.request.model"), isOccurrence),
				errorToolName: CH.anyIf($.SpanAttributes.get("gen_ai.tool.name"), isOccurrence),
				errorHttpMethod: CH.anyIf($.SpanAttributes.get("http.request.method"), isOccurrence),
				errorHttpRoute: CH.anyIf($.SpanAttributes.get("http.route"), isOccurrence),
				errorQueryContext: CH.anyIf($.SpanAttributes.get("query.context"), isOccurrence),
				errorType: CH.anyIf($.SpanAttributes.get("error.type"), isOccurrence),
				errorLabel: CH.any_($.occurrence.occurrenceLabel),
				exceptionType: CH.any_($.occurrence.occurrenceExceptionType),
				exceptionMessage: CH.any_($.occurrence.occurrenceExceptionMessage),
			}
		})
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			inSubquery(
				$.TraceId,
				fromQuery(occurrences, "matching_traces").select(($$) => ({ TraceId: $$.TraceId })),
			),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
		])
		.groupBy("traceId")
		.orderBy(["startTime", "desc"])
		.format("JSON")
}
