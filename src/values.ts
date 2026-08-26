import { isRecord } from "./util.js";

const sensitiveKey = /(?:authorization|api[-_]?key|token|secret)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? "[redacted]" : redact(item)]),
  );
}

export function parsePositiveInteger(value: string, option: string, maximum?: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${option} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${option} must be a positive integer`);
  if (maximum !== undefined && parsed > maximum) {
    throw new Error(`${option} must be between 1 and ${maximum}`);
  }
  return parsed;
}

export function parseCommaList(
  value: string,
  option: string,
  options: { allowEmpty?: boolean; maximum?: number } = {},
): string[] {
  if (value.trim() === "") {
    if (options.allowEmpty) return [];
    throw new Error(`${option} cannot be empty`);
  }

  const values = value.split(",").map((item) => item.trim());
  if (values.some((item) => item === "")) throw new Error(`${option} contains an empty value`);
  if (new Set(values).size !== values.length) throw new Error(`${option} contains a duplicate value`);
  if (options.maximum !== undefined && values.length > options.maximum) {
    throw new Error(`${option} accepts at most ${options.maximum} values`);
  }
  return values;
}

export function parseBooleanValue(value: string, option: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${option} must be true or false`);
}

export function validateDate(value: string, option: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const dateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
  if (!date.test(value) && !dateTime.test(value)) {
    throw new Error(`${option} must use YYYY-MM-DD or an ISO 8601 UTC timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error(`${option} is not a valid date`);
  }
  return value;
}

export function validateId(value: string, kind: "note" | "folder" | "webhook"): string {
  const definitions = {
    note: { pattern: /^not_[A-Za-z0-9]{14}$/, example: "not_ followed by 14 letters or numbers" },
    folder: { pattern: /^fol_[A-Za-z0-9]{14}$/, example: "fol_ followed by 14 letters or numbers" },
    webhook: { pattern: /^whe_[A-Za-z0-9]{14}$/, example: "whe_ followed by 14 letters or numbers" },
  } as const;
  const definition = definitions[kind];
  if (!definition.pattern.test(value)) throw new Error(`Invalid ${kind} ID "${value}". Expected ${definition.example}.`);
  return value;
}

export function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid base URL "${value}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Invalid base URL "${value}". Use HTTP or HTTPS.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The base URL cannot include credentials, a query string, or a fragment");
  }
  return url.toString().replace(/\/$/, "");
}

export function validateWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid webhook URL "${value}"`);
  }
  if (url.protocol !== "https:") throw new Error("--url must use HTTPS");
  if (url.username || url.password) throw new Error("--url cannot include embedded credentials");
  return url.toString();
}

export function redactWebhookUrl(value: string): string {
  const url = new URL(value);
  if (url.pathname === "/" && !url.search && !url.hash) return url.origin;
  return `${url.origin}/[redacted]`;
}
