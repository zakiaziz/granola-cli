import { isRecord } from "./util.js";
import { CliError } from "./errors.js";

const sensitiveKey = /(?:authorization|api[-_]?key|token|secret)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? "[redacted]" : redact(item)]),
  );
}

export function parsePositiveInteger(value: string, option: string, maximum?: number): number {
  if (!/^\d+$/.test(value)) throw new CliError(`${option} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new CliError(`${option} must be a positive integer`);
  if (maximum !== undefined && parsed > maximum) {
    throw new CliError(`${option} must be between 1 and ${maximum}`);
  }
  return parsed;
}

export function parseBooleanValue(value: string, option: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CliError(`${option} must be true or false`);
}

export function validateDate(value: string, option: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const dateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
  if (!date.test(value) && !dateTime.test(value)) {
    throw new CliError(`${option} must use YYYY-MM-DD or an ISO 8601 UTC timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new CliError(`${option} is not a valid date`);
  }
  return value;
}

export function validateId(value: string, kind: "note" | "folder" | "webhook"): string {
  if (value.length === 0 || /[\x00-\x1f]/.test(value)) throw new CliError(`Invalid ${kind} ID: IDs must be nonempty opaque strings without control characters.`);
  return value;
}

export function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`Invalid base URL "${value}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CliError(`Invalid base URL "${value}". Use HTTP or HTTPS.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CliError("The base URL cannot include credentials, a query string, or a fragment");
  }
  return url.toString().replace(/\/$/, "");
}

export function validateWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`Invalid webhook URL "${value}"`);
  }
  if (url.protocol !== "https:") throw new CliError("--url must use HTTPS");
  if (url.username || url.password) throw new CliError("--url cannot include embedded credentials");
  return url.toString();
}

export function redactWebhookUrl(value: string): string {
  const url = new URL(value);
  if (url.pathname === "/" && !url.search && !url.hash) return url.origin;
  return `${url.origin}/[redacted]`;
}
