// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { CliError, type ErrorCode, type ProviderInfo } from "./errors.js";
import { cleanProviderText, errorCodeFor, invalidResponse, providerFailure, type Exchange, type RequestPlan } from "./http.js";
import { isRecord } from "./values.js";

const MAX_CODE_LENGTH = 64;

export interface GraphqlCall {
  /** Command name for messages. */
  name: string;
  /** Root field the request reads. */
  field?: string | undefined;
  mutation: boolean;
}

export interface GraphqlResult {
  /** The response data object. */
  data: Record<string, unknown>;
  /** The value of the root field, or the data object when the request names no field. */
  root: unknown;
}

interface GraphqlError {
  message: string;
  /** The code as the provider sent it, for the Provider.errorCodes lookup. */
  code?: string;
  path?: string;
}

/**
 * Interprets a GraphQL response (HTTP 200 with an errors array, partial data, a null mutation root) and returns its
 * data. Provider codes map through Provider.errorCodes before the status mapping. Failures never leave a malformed
 * body to be printed as a result.
 */
export function readGraphql(body: unknown, call: GraphqlCall, plan: RequestPlan, exchange: Exchange): GraphqlResult {
  const name = plan.provider.name;
  const invalid = (message: string): CliError => invalidResponse(plan, `${name} ${message} for ${call.name}.`, exchange, call.mutation);
  if (!isRecord(body)) throw invalid("returned a response that is not a GraphQL result");
  const errors = readErrors(body.errors, plan);
  if (errors === "malformed") throw invalid('returned a malformed "errors" value');
  const data = body.data;
  if (data !== undefined && data !== null && !isRecord(data)) throw invalid('returned a "data" value that is not an object');
  const usable = isRecord(data) && Object.values(data).some((value) => value !== null);
  if (errors.length > 0) {
    if (!isRecord(data) || !usable) throw rejection(errors, plan, exchange);
    throw partial(errors, data, call, plan, exchange);
  }
  if (!isRecord(data)) throw invalid('returned no "data" object');
  if (call.field === undefined) return { data, root: data };
  if (!Object.hasOwn(data, call.field)) throw invalid(`returned no "${call.field}" field`);
  const root = data[call.field];
  if (root === null && call.mutation) throw invalid(`returned a null "${call.field}" field`);
  const failure = call.mutation ? plan.provider.rootFailure?.(root) : undefined;
  if (failure) {
    const message = cleanProviderText(failure.message, plan);
    const code = failure.code === undefined ? undefined : cleanProviderText(String(failure.code), plan, MAX_CODE_LENGTH);
    throw providerFailure(plan, exchange.status, { ...(code ? { code } : {}), ...requestIdOf(exchange) }, message, failure.code);
  }
  return { data, root };
}

function requestIdOf(exchange: Exchange): ProviderInfo {
  return exchange.requestId ? { request_id: exchange.requestId } : {};
}

function readErrors(value: unknown, plan: RequestPlan): GraphqlError[] | "malformed" {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return "malformed";
  const errors: GraphqlError[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.message !== "string") return "malformed";
    const extensions = isRecord(item.extensions) ? item.extensions : undefined;
    const code = typeof extensions?.code === "string" && extensions.code !== "" ? extensions.code : undefined;
    const path = Array.isArray(item.path) ? item.path.filter((part) => typeof part === "string" || typeof part === "number").join(".") : "";
    const shownPath = cleanProviderText(path, plan, MAX_CODE_LENGTH);
    errors.push({
      message: cleanProviderText(item.message, plan) ?? "no message",
      ...(code ? { code } : {}),
      ...(shownPath ? { path: shownPath } : {}),
    });
  }
  return errors;
}

function joinedMessages(errors: readonly GraphqlError[]): string {
  return [...new Set(errors.map((error) => error.message))].join("; ");
}

function rejection(errors: readonly GraphqlError[], plan: RequestPlan, exchange: Exchange): CliError {
  const code = errors.find((error) => error.code !== undefined)?.code;
  const shown = code === undefined ? undefined : cleanProviderText(code, plan, MAX_CODE_LENGTH);
  return providerFailure(plan, exchange.status, { ...(shown ? { code: shown } : {}), ...requestIdOf(exchange) }, joinedMessages(errors), code);
}

function partial(
  errors: readonly GraphqlError[],
  data: Record<string, unknown>,
  call: GraphqlCall,
  plan: RequestPlan,
  exchange: Exchange,
): CliError {
  const count = errors.length;
  const failed = errors.map((error) => ({
    step: error.path ?? "request",
    error: { code: errorCodeFor(plan, error.code, exchange.status) as ErrorCode, message: error.message },
  }));
  const completed = Object.entries(data)
    .filter(([, result]) => result !== null)
    .map(([step, result]) => ({ step, result }));
  return new CliError(
    "PARTIAL_FAILURE",
    `${plan.provider.name} returned data together with ${count} error${count === 1 ? "" : "s"} (HTTP ${exchange.status})${call.mutation ? "; nothing was rolled back" : ""}.`,
    {
      hint: call.mutation ? "Check the remote state before retrying." : "Use the partial result, or retry later.",
      retryable: false,
      ...(call.mutation ? { outcome: "unknown" as const } : {}),
      provider: { status: exchange.status, ...requestIdOf(exchange) },
      partial: { completed, failed, not_attempted: [] },
    },
  );
}
