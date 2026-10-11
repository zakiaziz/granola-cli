import { describe, expect, test } from "bun:test";
import { ApiError, CliError, asCliError, statusFailure } from "../src/errors.js";

describe("typed failures", () => {
  test("maps provider statuses to stable exit contracts", () => {
    expect(statusFailure(401)).toEqual({ code: "AUTHENTICATION_FAILED", exitCode: 3, retryable: false });
    expect(statusFailure(403).exitCode).toBe(4);
    expect(statusFailure(404).exitCode).toBe(5);
    expect(statusFailure(412).exitCode).toBe(6);
    expect(statusFailure(429)).toEqual({ code: "TRANSIENT_FAILURE", exitCode: 7, retryable: true });
    expect(statusFailure(503).retryable).toBe(true);
    expect(statusFailure(400).exitCode).toBe(1);
  });
  test("preserves typed failures and classifies unexpected values", () => {
    const typed = new ApiError("no", "PROVIDER_ERROR", 1, false, { status: 400 });
    expect(asCliError(typed)).toBe(typed);
    expect(asCliError(new Error("boom"))).toMatchObject({ message: "boom", code: "INTERNAL_ERROR", exitCode: 1 });
    expect(asCliError("bad")).toBeInstanceOf(CliError);
  });
});
