// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
export const ERROR_CODES = [
  "UNEXPECTED_ERROR",
  "PROVIDER_ERROR",
  "INVALID_RESPONSE",
  "UNSUPPORTED_RESPONSE",
  "INVALID_ARGUMENT",
  "INVALID_REQUEST",
  "CONFIGURATION_ERROR",
  "AUTHENTICATION_REQUIRED",
  "AUTHENTICATION_FAILED",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "TRANSIENT_FAILURE",
  "PARTIAL_FAILURE",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_DECLINED",
  "INTERRUPTED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const EXIT_CODES: Record<ErrorCode, number> = {
  UNEXPECTED_ERROR: 1,
  PROVIDER_ERROR: 1,
  INVALID_RESPONSE: 1,
  UNSUPPORTED_RESPONSE: 1,
  INVALID_ARGUMENT: 2,
  INVALID_REQUEST: 2,
  CONFIGURATION_ERROR: 3,
  AUTHENTICATION_REQUIRED: 3,
  AUTHENTICATION_FAILED: 3,
  PERMISSION_DENIED: 4,
  NOT_FOUND: 5,
  CONFLICT: 6,
  RATE_LIMITED: 7,
  TRANSIENT_FAILURE: 7,
  PARTIAL_FAILURE: 8,
  CONFIRMATION_REQUIRED: 9,
  CONFIRMATION_DECLINED: 9,
  INTERRUPTED: 130,
};

export interface ProviderInfo {
  status?: number;
  /** The provider's own code. Numeric codes stay numeric. */
  code?: string | number;
  request_id?: string;
  retry_after_seconds?: number;
}

/** Why one step or item failed. provider carries what the provider reported for it, such as its own numeric code. */
export interface StepError {
  code: ErrorCode;
  message: string;
  provider?: ProviderInfo;
  details?: Record<string, unknown>;
}

export interface StepPartial {
  completed: { step: string; result: unknown }[];
  failed: { step: string; error: StepError }[];
  not_attempted: { step: string }[];
}

export interface PagePartial {
  data: unknown[];
  next_cursor: string | null;
}

export interface ErrorExtra {
  hint?: string;
  retryable?: boolean;
  outcome?: "unknown";
  provider?: ProviderInfo;
  details?: Record<string, unknown>;
  partial?: StepPartial | PagePartial;
}

export class CliError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: ErrorExtra = {},
  ) {
    super(message);
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}

export function usageError(message: string, hint: string, details?: Record<string, unknown>): CliError {
  return new CliError("INVALID_ARGUMENT", message, { hint, ...(details ? { details } : {}) });
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  return new CliError("UNEXPECTED_ERROR", error instanceof Error ? error.message : String(error));
}

export interface FailureContext {
  providerName: string;
  message?: string | undefined;
  mutation: boolean;
  authenticationHint: string;
  permissionHint: string;
  /** Code the provider's own error code maps to. It takes precedence over the status mapping. */
  code?: ErrorCode | undefined;
}

export function httpFailure(status: number, provider: ProviderInfo, context: FailureContext): CliError {
  const code = context.code ?? failureCode(status);
  const transient = code === "RATE_LIMITED" || code === "TRANSIENT_FAILURE";
  const reason = context.message ? `: ${context.message}` : "";
  return new CliError(code, `${context.providerName} rejected the request${reason} (HTTP ${status}).`, {
    ...hintFor(code, provider, context),
    retryable: transient && !context.mutation,
    ...(context.mutation && code === "TRANSIENT_FAILURE" ? { outcome: "unknown" as const } : {}),
    provider: { status, ...provider },
  });
}

export function failureCode(status: number): ErrorCode {
  if (status === 401) return "AUTHENTICATION_FAILED";
  if (status === 403) return "PERMISSION_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409 || status === 412) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  if ([500, 502, 503, 504].includes(status)) return "TRANSIENT_FAILURE";
  if (status === 400 || status === 422) return "INVALID_REQUEST";
  return "PROVIDER_ERROR";
}

function hintFor(code: ErrorCode, provider: ProviderInfo, context: FailureContext): { hint?: string } {
  if (code === "AUTHENTICATION_FAILED") return { hint: context.authenticationHint };
  if (code === "PERMISSION_DENIED") return { hint: context.permissionHint };
  if (code === "RATE_LIMITED") return { hint: waitHint(provider.retry_after_seconds, context.mutation) };
  if (code === "TRANSIENT_FAILURE") {
    return { hint: context.mutation ? "Check the remote state before retrying." : "Retry later." };
  }
  return {};
}

export function waitHint(seconds: number | undefined, mutation: boolean): string {
  const wait = seconds === undefined ? "Wait" : `Wait ${seconds} seconds`;
  return mutation ? `${wait}. Check the remote state before retrying.` : `${wait} and retry.`;
}

export interface StepsFailureExtra {
  /** What the entries are. Default: steps. */
  unit?: "steps" | "items";
  /** Code of the failure that stopped the operation, kept under details.cause. */
  cause?: ErrorCode;
  outcome?: "unknown";
  /** HTTP status, request ID, and code of the response that reported the failure. */
  provider?: ProviderInfo;
  /** Non-secret structured context. details.cause is set from cause and wins over a key of the same name. */
  details?: Record<string, unknown>;
  hint?: string;
}

/**
 * Builds the PARTIAL_FAILURE for an operation that completed some steps or items (STYLE-ERR-4).
 * The message never implies a rollback. Registry hooks throw it, for example when a batch response lists failed items.
 */
export function stepsFailure(partial: StepPartial, extra: StepsFailureExtra = {}): CliError {
  const total = partial.completed.length + partial.failed.length + partial.not_attempted.length;
  const unit = extra.unit ?? "steps";
  return new CliError("PARTIAL_FAILURE", `${partial.completed.length} of ${total} ${unit} completed; nothing was rolled back.`, {
    hint: extra.hint ?? "Check the remote state before retrying.",
    retryable: false,
    ...(extra.outcome ? { outcome: extra.outcome } : {}),
    ...(extra.provider ? { provider: extra.provider } : {}),
    ...(extra.cause || extra.details ? { details: { ...extra.details, ...(extra.cause ? { cause: extra.cause } : {}) } } : {}),
    partial,
  });
}
