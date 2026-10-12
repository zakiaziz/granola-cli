// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { reportedProfile, type Access } from "./access.js";
import { credentialNoun, credentialVariables, isSecret, type Credential } from "./credentials.js";
import { asCliError, CliError, failureCode, httpFailure, waitHint, type ErrorCode, type PagePartial, type ProviderInfo, type StepError, type StepPartial } from "./errors.js";
import { printDiagnostic } from "./output.js";
import type { Provider } from "./provider.js";
import type { HttpMethod } from "./types.js";
import { isRecord, redactUrl, REDACTED, sensitiveValues, WHOLE_TOKEN_BELOW } from "./values.js";

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [250, 500];
const MAX_RETRY_AFTER_SECONDS = 10;
const MAX_MESSAGE_LENGTH = 500;
const MAX_CODE_LENGTH = 64;
const MAX_REQUEST_ID_LENGTH = 128;

/** What one request needs, before credentials and the endpoint are applied. */
export interface PlanInput {
  method: HttpMethod;
  path: string;
  query: readonly (readonly [string, string])[];
  body?: unknown;
  /** Changes remote state. Mutations make one attempt and carry outcome "unknown" when it is unclear whether they applied. */
  mutation: boolean;
  /** The response is returned as raw JSON or text, and binary content fails. */
  raw: boolean;
  secretValues: readonly string[];
}

export interface PlanEnvironment {
  provider: Provider;
  access: Access;
  credential: Credential | undefined;
  timeoutMs: number;
}

export interface RequestPlan {
  provider: Provider;
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  safe: boolean;
  raw: boolean;
  timeoutMs: number;
  profile: string | null;
  /** Header names that authorize() produced. Previews hide their values whatever the names. */
  credentialHeaders: string[];
  /** Values scrubbed from every provider text wherever they appear, longest first. */
  secrets: string[];
  /** Short values guessed from sensitive keys, scrubbed only where they stand alone. */
  shortSecrets: string[];
}

export interface Exchange {
  status: number;
  contentType: string;
  text: string;
  requestId?: string;
}

export function buildPlan(input: PlanInput, environment: PlanEnvironment): RequestPlan {
  const { provider, access, credential } = environment;
  const url = new URL(provider.baseUrl.allowPath ? access.baseUrl : `${new URL(access.baseUrl).origin}${input.path}`);
  for (const [key, value] of input.query) url.searchParams.append(key, value);
  const credentialHeaders = credential ? provider.authorize(credential.values) : {};
  const headers: Record<string, string> = { ...provider.headers, ...credentialHeaders, Accept: "application/json" };
  if (input.body !== undefined) headers["Content-Type"] = "application/json";
  return {
    provider,
    method: input.method,
    url: url.toString(),
    headers,
    ...(input.body === undefined ? {} : { body: input.body }),
    safe: !input.mutation,
    raw: input.raw,
    timeoutMs: environment.timeoutMs,
    profile: reportedProfile(access),
    credentialHeaders: Object.keys(credentialHeaders),
    ...scrubbedValues(provider, credential, credentialHeaders, input),
  };
}

/**
 * Collects what errors must never echo: secret credential fields, authorize() header values, values the provider
 * derives, values the request declares, and values guessed from sensitive body and query keys (STYLE-CFG-7).
 */
function scrubbedValues(
  provider: Provider,
  credential: Credential | undefined,
  credentialHeaders: Readonly<Record<string, string>>,
  input: PlanInput,
): { secrets: string[]; shortSecrets: string[] } {
  const values = credential?.values ?? {};
  const known = [
    ...provider.secrets.filter(isSecret).map((field) => values[field.key]),
    ...Object.values(credentialHeaders),
    ...(credential ? (provider.secretValues?.(credential.values) ?? []) : []),
    ...input.secretValues,
  ];
  const guessed = sensitiveValues(input.body, input.query);
  const longest = (items: string[]): string[] => [...new Set(items)].sort((left, right) => right.length - left.length);
  return {
    secrets: longest([
      ...known.filter((value): value is string => value !== undefined && value !== ""),
      ...guessed.filter((value) => value.length >= WHOLE_TOKEN_BELOW),
    ]),
    shortSecrets: longest(guessed.filter((value) => value.length < WHOLE_TOKEN_BELOW)),
  };
}

/**
 * Sends a request with the retries its safety allows. With a deadline (epoch milliseconds) no attempt outlasts it:
 * each attempt's timeout is capped to the time left, and a retry that would start after it is not made, so the last
 * failure is thrown instead.
 */
export async function performRequest(plan: RequestPlan, deadline?: number): Promise<Exchange> {
  const attempts = plan.safe ? MAX_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt += 1) {
    const left = deadline === undefined ? Number.POSITIVE_INFINITY : deadline - Date.now();
    if (left <= 0) throw deadlinePassed(plan);
    const timeoutMs = Math.min(plan.timeoutMs, left);
    printDiagnostic("request", {
      method: plan.method,
      url: displayUrl(plan),
      attempt,
      timeout_ms: timeoutMs,
      profile: plan.profile,
    });
    try {
      return await attemptOnce({ ...plan, timeoutMs });
    } catch (error) {
      const failure = limitRetryAfter(asCliError(error));
      const delay = retryDelay(failure, attempt, attempts);
      if (delay === undefined || (deadline !== undefined && Date.now() + delay >= deadline)) throw failure;
      printDiagnostic("retry", { attempt, delay_ms: delay, reason: failure.code });
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (deadline !== undefined && Date.now() >= deadline) throw failure;
    }
  }
}

/** The deadline passed before an attempt could start, so nothing was sent. */
function deadlinePassed(plan: RequestPlan): CliError {
  return new CliError("TRANSIENT_FAILURE", `${plan.provider.name} request was not sent because its deadline had passed.`, {
    hint: "Increase --timeout or retry.",
    retryable: plan.safe,
  });
}

function limitRetryAfter(failure: CliError): CliError {
  const wait = failure.extra.provider?.retry_after_seconds;
  if (failure.code !== "TRANSIENT_FAILURE" || wait === undefined || wait <= MAX_RETRY_AFTER_SECONDS) return failure;
  return new CliError("RATE_LIMITED", failure.message, {
    ...failure.extra,
    hint: waitHint(wait, failure.extra.outcome === "unknown"),
  });
}

function retryDelay(failure: CliError, attempt: number, attempts: number): number | undefined {
  if (attempt >= attempts) return undefined;
  if (failure.code !== "RATE_LIMITED" && failure.code !== "TRANSIENT_FAILURE") return undefined;
  const retryAfter = failure.extra.provider?.retry_after_seconds;
  if (retryAfter === undefined) return BACKOFF_MS[attempt - 1] ?? BACKOFF_MS.at(-1);
  return retryAfter > MAX_RETRY_AFTER_SECONDS ? undefined : retryAfter * 1000;
}

const DECODER = new TextDecoder("utf-8", { fatal: true });

async function attemptOnce(plan: RequestPlan): Promise<Exchange> {
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(plan.url, {
      method: plan.method,
      redirect: "error",
      headers: plan.headers,
      ...(plan.body === undefined ? {} : { body: JSON.stringify(plan.body) }),
      signal: AbortSignal.timeout(plan.timeoutMs),
    });
  } catch (error) {
    throw networkFailure(error, plan);
  }
  const requestId = scrubSecrets(requestIdOf(response.headers, plan.provider), plan);
  printDiagnostic("response", { status: response.status, duration_ms: Date.now() - started, request_id: requestId ?? null });
  const contentType = response.headers.get("content-type") ?? "";
  const bodyless = plan.method === "HEAD" || response.status === 204 || response.status === 205;
  const known = { status: response.status, contentType, ...(requestId ? { requestId } : {}) };
  if (response.ok && plan.raw && !bodyless && contentType !== "" && !isTextual(contentType)) {
    await response.body?.cancel();
    throw unsupportedResponse(`${plan.provider.name} returned binary content (${scrubSecrets(contentType, plan)}).`, { ...known, text: "" }, plan);
  }
  let bytes = new Uint8Array();
  try {
    if (!bodyless) bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (!response.ok) throw statusFailure(response, "", plan);
    throw networkFailure(error, plan);
  }
  if (!response.ok) throw statusFailure(response, new TextDecoder("utf-8").decode(bytes), plan);
  try {
    return { ...known, text: DECODER.decode(bytes) };
  } catch {
    const message = `${plan.provider.name} returned a body that is not UTF-8 text.`;
    if (plan.raw) throw unsupportedResponse(message, { ...known, text: "" }, plan);
    throw undecodableResponse(plan, message, { ...known, text: "" }, !plan.safe);
  }
}

function requestIdOf(headers: Headers, provider: Provider): string | undefined {
  const names = typeof provider.requestIdHeader === "string" ? [provider.requestIdHeader] : provider.requestIdHeader;
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null && value !== "") return value;
  }
  return undefined;
}

export function scrubSecrets(value: string, plan: RequestPlan): string;
export function scrubSecrets(value: string | undefined, plan: RequestPlan): string | undefined;
export function scrubSecrets(value: string | undefined, plan: RequestPlan): string | undefined {
  if (value === undefined) return undefined;
  const whole = plan.secrets.reduce((text, secret) => text.split(secret).join(REDACTED), value);
  return plan.shortSecrets.reduce((text, secret) => text.replace(wholeToken(secret), REDACTED), whole);
}

function wholeToken(secret: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "g");
}

/** Scrubs every string inside a value that is about to be printed, such as a dry-run body. */
export function scrubDeep(value: unknown, plan: RequestPlan): unknown {
  if (typeof value === "string") return scrubSecrets(value, plan);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, plan));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubDeep(item, plan)]));
}

/** The request URL for diagnostics, previews, and prompts: sensitive query parameters and declared secrets hidden. */
export function displayUrl(plan: RequestPlan, url = plan.url): string {
  return scrubSecrets(redactUrl(url), plan);
}

/** Scrubs secrets from provider text, collapses whitespace and control characters, and bounds the length. */
export function cleanProviderText(value: string | undefined, plan: RequestPlan, max = MAX_MESSAGE_LENGTH): string | undefined {
  if (value === undefined) return undefined;
  const text = scrubSecrets(value, plan)
    .replace(/[\u0000-\u001f\u007f\s]+/g, " ")
    .trim();
  if (text === "") return undefined;
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/**
 * Scrubs a failure that provider code in a hook threw (select, settle, Step.validate): every string it carries, the
 * provider info, the details, and all steps and items, whose failure messages are also collapsed and bounded like a
 * provider error message.
 */
export function scrubFailure(failure: CliError, plan: RequestPlan): CliError {
  const { hint, details, provider, partial } = failure.extra;
  return new CliError(failure.code, cleanProviderText(failure.message, plan) ?? failure.message, {
    ...failure.extra,
    ...(hint === undefined ? {} : { hint: scrubSecrets(hint, plan) }),
    ...(details === undefined ? {} : { details: scrubDeep(details, plan) as Record<string, unknown> }),
    ...(provider === undefined ? {} : { provider: scrubDeep(provider, plan) as ProviderInfo }),
    ...(partial === undefined ? {} : { partial: scrubbedPartial(partial, plan) }),
  });
}

function scrubbedPartial(partial: StepPartial | PagePartial, plan: RequestPlan): StepPartial | PagePartial {
  if (!("failed" in partial)) return scrubDeep(partial, plan) as PagePartial;
  // A failure message is cleaned from its original text, so a secret is never matched inside an earlier replacement.
  const failed = partial.failed.map(({ step, error }) => ({
    step: scrubSecrets(step, plan),
    error: { ...(scrubDeep({ ...error, message: "" }, plan) as StepError), message: cleanProviderText(error.message, plan) ?? "" },
  }));
  return {
    completed: scrubDeep(partial.completed, plan) as StepPartial["completed"],
    failed,
    not_attempted: scrubDeep(partial.not_attempted, plan) as StepPartial["not_attempted"],
  };
}

/** Runs provider code that shapes a response. A CliError it throws is scrubbed before it can print. */
export function guardHook<T>(plan: RequestPlan, hook: () => T): T {
  try {
    return hook();
  } catch (error) {
    throw error instanceof CliError ? scrubFailure(error, plan) : error;
  }
}

function unsupportedResponse(message: string, exchange: Exchange, plan: RequestPlan): CliError {
  return new CliError("UNSUPPORTED_RESPONSE", message, {
    hint: "Raw output supports JSON and text responses only.",
    provider: providerOf(exchange, true),
    ...(plan.safe ? {} : { outcome: "unknown" as const }),
  });
}

function networkFailure(error: unknown, plan: RequestPlan): CliError {
  const timedOut = error instanceof Error && error.name === "TimeoutError";
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
  const reason = timedOut ? `timed out after ${plan.timeoutMs} ms` : typeof cause === "string" ? `failed (${cause})` : "failed";
  const applied = plan.safe ? "" : "; the mutation may have been applied";
  const safeHint = timedOut ? "Increase --timeout or retry." : "Check network access and retry.";
  return new CliError("TRANSIENT_FAILURE", `${plan.provider.name} request ${reason} before a complete response${applied}.`, {
    hint: plan.safe ? safeHint : "Check the remote state before retrying.",
    retryable: plan.safe,
    ...(plan.safe ? {} : { outcome: "unknown" as const }),
  });
}

function statusFailure(response: Response, text: string, plan: RequestPlan): CliError {
  const { provider: definition } = plan;
  const detail = definition.errorDetail(parseJson(text));
  const code = typeof detail.code === "string" ? cleanProviderText(detail.code, plan, MAX_CODE_LENGTH) : detail.code;
  const rawCode = detail.code;
  const requestId = cleanProviderText(requestIdOf(response.headers, definition) ?? detail.requestId, plan, MAX_REQUEST_ID_LENGTH);
  const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
  return providerFailure(plan, response.status, {
    ...(code === undefined || code === "" ? {} : { code }),
    ...(requestId ? { request_id: requestId } : {}),
    ...(retryAfter === undefined ? {} : { retry_after_seconds: retryAfter }),
  }, cleanProviderText(detail.message, plan), rawCode);
}

/** Builds the failure for a provider rejection, mapping its code through Provider.errorCodes before the status. */
export function providerFailure(
  plan: RequestPlan,
  status: number,
  provider: ProviderInfo,
  message: string | undefined,
  rawCode: string | number | undefined = provider.code,
): CliError {
  const { provider: definition } = plan;
  const noun = credentialNoun(definition);
  return httpFailure(status, provider, {
    providerName: definition.name,
    message,
    mutation: !plan.safe,
    authenticationHint: `Set ${credentialVariables(definition)} to a valid ${noun}, or run '${definition.bin} setup'.`,
    permissionHint: `Check that the ${noun} can access this resource.`,
    code: mappedCode(plan, rawCode),
  });
}

/** The error code for a provider rejection: the Provider.errorCodes mapping, then the status mapping. */
export function errorCodeFor(plan: RequestPlan, code: string | number | undefined, status: number): ErrorCode {
  return mappedCode(plan, code) ?? failureCode(status);
}

function mappedCode(plan: RequestPlan, code: string | number | undefined): ErrorCode | undefined {
  const table = plan.provider.errorCodes;
  if (code === undefined || !table) return undefined;
  const key = String(code);
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function retryAfterSeconds(header: string | null): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  if (/^\d+$/.test(header.trim())) {
    const seconds = Number(header.trim());
    return Number.isSafeInteger(seconds) ? seconds : Number.MAX_SAFE_INTEGER;
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isJsonType(contentType: string): boolean {
  return /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType);
}

function isTextual(contentType: string): boolean {
  return isJsonType(contentType) || /^text\//i.test(contentType) || /^application\/(?:[\w.+-]+\+)?xml\b/i.test(contentType);
}

export function decodeJson(exchange: Exchange, mutation: boolean, plan: RequestPlan): unknown {
  if (exchange.text === "") return null;
  const name = plan.provider.name;
  if (!isJsonType(exchange.contentType)) {
    throw undecodableResponse(plan, `${name} returned ${scrubSecrets(exchange.contentType, plan) || "an unknown content type"} instead of JSON.`, exchange, mutation);
  }
  try {
    return JSON.parse(exchange.text);
  } catch {
    throw undecodableResponse(plan, `${name} returned invalid JSON (HTTP ${exchange.status}).`, exchange, mutation);
  }
}

export function decodeRaw(exchange: Exchange, mutation: boolean, plan: RequestPlan): unknown {
  if (exchange.text === "") return null;
  return isJsonType(exchange.contentType) ? decodeJson(exchange, mutation, plan) : exchange.text;
}

function providerOf(exchange: Exchange, withStatus: boolean): ProviderInfo {
  return {
    ...(withStatus ? { status: exchange.status } : {}),
    ...(exchange.requestId ? { request_id: exchange.requestId } : {}),
  };
}

function invalidResponseHint(plan: RequestPlan, mutation: boolean): string {
  return mutation
    ? "Check the remote state before retrying."
    : `Retry later. If the failure persists, the ${plan.provider.name} API contract may have changed.`;
}

/**
 * A response whose content breaks the contract: a wrong shape, a repeated cursor, an oversized page. The HTTP
 * exchange succeeded, so provider carries the request ID only.
 */
export function invalidResponse(plan: RequestPlan, message: string, exchange: Exchange, mutation = false): CliError {
  const provider = providerOf(exchange, false);
  return new CliError("INVALID_RESPONSE", message, {
    hint: invalidResponseHint(plan, mutation),
    ...(mutation ? { outcome: "unknown" as const } : {}),
    ...(Object.keys(provider).length > 0 ? { provider } : {}),
  });
}

/** A response that could not be decoded at all: a wrong content type, invalid JSON, or text that is not UTF-8. Carries the HTTP status. */
function undecodableResponse(plan: RequestPlan, message: string, exchange: Exchange, mutation: boolean): CliError {
  return new CliError("INVALID_RESPONSE", message, {
    hint: invalidResponseHint(plan, mutation),
    ...(mutation ? { outcome: "unknown" as const } : {}),
    provider: providerOf(exchange, true),
  });
}
