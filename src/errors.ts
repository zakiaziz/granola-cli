export class CliError extends Error {
  constructor(message: string, readonly code = "INVALID_ARGUMENT", readonly exitCode = 2, readonly details: Record<string, unknown> = {}) { super(message); this.name = "CliError"; }
}
export class ApiError extends CliError {
  constructor(message: string, code: string, exitCode: number, readonly retryable: boolean, details: Record<string, unknown>) { super(message, code, exitCode, details); }
}
export function statusFailure(status: number): {
  code: string;
  exitCode: number;
  retryable: boolean;
} {
  if (status === 401)
    return { code: "AUTHENTICATION_FAILED", exitCode: 3, retryable: false };
  if (status === 403)
    return { code: "PERMISSION_DENIED", exitCode: 4, retryable: false };
  if (status === 404)
    return { code: "NOT_FOUND", exitCode: 5, retryable: false };
  if (status === 409 || status === 412)
    return { code: "CONFLICT", exitCode: 6, retryable: false };
  if (status === 429 || status >= 500)
    return { code: "TRANSIENT_FAILURE", exitCode: 7, retryable: true };
  return { code: "PROVIDER_ERROR", exitCode: 1, retryable: false };
}
export function asCliError(error: unknown): CliError { return error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error), "INTERNAL_ERROR", 1); }
