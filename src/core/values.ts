// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { readFileSync } from "node:fs";
import { CliError, usageError } from "./errors.js";

const SENSITIVE_KEY = /api.?key|token|secret|password|authorization|cookie/i;
export const REDACTED = "[redacted]";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) && item !== null && item !== undefined ? REDACTED : redact(item),
    ]),
  );
}

/**
 * Values shorter than this are not collected by `sensitiveValues`. They are guessed from key names, and replacing a
 * value such as "1" would garble unrelated provider text. Values a provider declares are always scrubbed.
 */
export const MIN_GUESSED_SECRET_LENGTH = 2;

/** A guessed value shorter than this is scrubbed only where it stands alone, not inside a longer word or number. */
export const WHOLE_TOKEN_BELOW = 4;

/**
 * Collects the string and number values that `redact` would hide from a body and query, so errors can scrub them too.
 * Values shorter than MIN_GUESSED_SECRET_LENGTH are skipped.
 */
export function sensitiveValues(body: unknown, query: readonly (readonly [string, string])[] = []): string[] {
  const found: string[] = query.filter(([key]) => SENSITIVE_KEY.test(key)).map(([, value]) => value);
  const walk = (value: unknown, hidden: boolean): void => {
    if (typeof value === "string") {
      if (hidden) found.push(value);
    } else if (typeof value === "number") {
      if (hidden) found.push(String(value));
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, hidden);
    } else if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) walk(item, hidden || SENSITIVE_KEY.test(key));
    }
  };
  walk(body, false);
  return found.filter((value) => value.length >= MIN_GUESSED_SECRET_LENGTH);
}

/** Hides userinfo and sensitive query values in a string that is echoed back in an error. Tolerates malformed URLs and paths. */
export function redactCredentials(value: string): string {
  return redactUserinfo(redactQueryValues(value));
}

function redactQueryValues(value: string): string {
  const start = value.indexOf("?");
  if (start < 0) return value;
  const hash = value.indexOf("#", start);
  const end = hash < 0 ? value.length : hash;
  const query = value.slice(start + 1, end).replace(/[^&;?]+/g, (pair) => {
    const equals = pair.indexOf("=");
    if (equals < 0) return pair;
    return SENSITIVE_KEY.test(decodeName(pair.slice(0, equals))) ? `${pair.slice(0, equals + 1)}${REDACTED}` : pair;
  });
  return `${value.slice(0, start + 1)}${query}${value.slice(end)}`;
}

function decodeName(name: string): string {
  try {
    return decodeURIComponent(name.replaceAll("+", " "));
  } catch {
    return name;
  }
}

function redactUserinfo(value: string): string {
  const prefix = /^[\s\u0000-\u001f]*(?:[a-z][a-z0-9+.-]*:(?:[/\\]*)|[/\\]{2})/i.exec(value)?.[0];
  if (prefix === undefined) return value;
  const rest = value.slice(prefix.length);
  const stop = rest.search(/[/\\?#]/);
  const authority = stop < 0 ? rest : rest.slice(0, stop);
  const at = authority.lastIndexOf("@");
  return at < 0 ? value : `${prefix}${REDACTED}@${rest.slice(at + 1)}`;
}

export function redactUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, REDACTED);
  }
  return url.toString().replaceAll("%5Bredacted%5D", REDACTED);
}

function subjectKind(subject: string): "option" | "argument" {
  return subject.startsWith("--") ? "option" : "argument";
}

export function invalidValue(subject: string, constraint: string, received: string, hint: string, allowed?: string): CliError {
  return usageError(`${subject} must ${constraint}; received "${received}".`, hint, {
    [subjectKind(subject)]: subject,
    received,
    ...(allowed === undefined ? {} : { allowed }),
  });
}

export function invalidVariable(variable: string, constraint: string, received: string, hint: string, allowed?: string): CliError {
  return new CliError("CONFIGURATION_ERROR", `${variable} must ${constraint}; received "${received}".`, {
    hint,
    details: { variable, received, ...(allowed === undefined ? {} : { allowed }) },
  });
}

export function missingFields(command: string, options: readonly string[], change: boolean): CliError {
  const names = options.map((option) => `--${option}`);
  const list = names.length <= 2 ? names.join(" or ") : `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;
  return usageError(`"${command}" needs at least one field${change ? " to change" : ""}.`, `Add ${list}.`);
}

export function emptyValue(subject: string): CliError {
  return usageError(`${subject} must not be empty; received "".`, `Provide a value for ${subject}.`, {
    [subjectKind(subject)]: subject,
    received: "",
  });
}

export function emptyVariable(variable: string): CliError {
  return new CliError("CONFIGURATION_ERROR", `${variable} must not be empty; received "".`, {
    hint: `Provide a value for ${variable}.`,
    details: { variable, received: "" },
  });
}

export function parseInteger(option: string, value: string, min: number, max?: number): number {
  const parsed = /^[0-9]{1,16}$/.test(value) ? Number(value) : Number.NaN;
  if (Number.isSafeInteger(parsed) && parsed >= min && (max === undefined || parsed <= max)) return parsed;
  const range = max === undefined ? `at least ${min}` : `from ${min} to ${max}`;
  const allowed = max === undefined ? `>=${min}` : `${min}-${max}`;
  throw invalidValue(option, `be an integer ${range}`, value, `Use ${option} ${max ?? min}.`, allowed);
}

const MAX_DURATION_MS = 600_000;

export function parseDuration(option: string, value: string): number {
  const match = /^([1-9][0-9]{0,14})(ms|s|m)$/.exec(value);
  const unit = match?.[2];
  const multiplier = unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  const milliseconds = match ? Number(match[1]) * multiplier : Number.NaN;
  if (Number.isSafeInteger(milliseconds) && milliseconds <= MAX_DURATION_MS) return milliseconds;
  throw invalidValue(
    option,
    "be a whole number with ms, s, or m, from 1ms to 10m",
    value,
    `Use ${option} 30s.`,
    "1ms-10m",
  );
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?(Z|[+-](\d{2}):(\d{2}))$/;
export const DATE_TIME_FORM = "YYYY-MM-DDTHH:MM:SS[.fff](Z|+HH:MM)";
const DATE_FORMS = `YYYY-MM-DD or ${DATE_TIME_FORM}`;

export function parseDate(option: string, value: string): string {
  const instant = dateInstant(value);
  if (instant !== undefined) return new Date(instant).toISOString();
  throw invalidValue(option, "be an ISO 8601 date or timestamp", value, "Use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ.", DATE_FORMS);
}

/** Validates a calendar date (YYYY-MM-DD) and returns it unchanged, for providers that filter by date and reject timestamps. */
export function parseCalendarDate(option: string, value: string): string {
  if (DATE_ONLY.test(value) && dateInstant(value) !== undefined) return value;
  throw invalidValue(option, "be a calendar date", echoable(value), "Use YYYY-MM-DD.", "YYYY-MM-DD");
}

function dateInstant(value: string): number | undefined {
  const dateOnly = DATE_ONLY.exec(value);
  const match = dateOnly ?? DATE_TIME.exec(value);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    return undefined;
  }
  if (dateOnly) return calendar.getTime();
  const [hour, minute, second] = [Number(match[4]), Number(match[5]), Number(match[6])];
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return undefined;
  const instant = Date.parse(value);
  return Number.isNaN(instant) ? undefined : instant;
}

export function parseKeyValue(option: string, value: string): [string, string] {
  const separator = value.indexOf("=");
  if (separator < 1) throw invalidValue(option, "be KEY=VALUE", value, `Use ${option} KEY=VALUE.`, "KEY=VALUE");
  return [value.slice(0, separator), value.slice(separator + 1)];
}

export function parseChoice(subject: string, value: string, choices: readonly string[]): string {
  if (choices.includes(value)) return value;
  throw invalidValue(
    subject,
    `be one of ${choices.join(", ")}`,
    value,
    `Use ${subject} ${choices[0] ?? "VALUE"}.`,
    choices.join(", "),
  );
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const BASE_URL_SCHEME = "be an https URL, or http for localhost, 127.0.0.1, or ::1";

export function baseUrlConstraint(value: string, allowPath: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return BASE_URL_SCHEME;
  }
  if (/[\s\u0000-\u001f\u007f\\]/.test(value) || !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return BASE_URL_SCHEME;
  const loopback = LOOPBACK_HOSTS.includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return BASE_URL_SCHEME;
  if (url.username || url.password || url.search || url.hash || /[?#]/.test(value)) {
    return "not include credentials, a query string, or a fragment";
  }
  const rawPath = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/.*)?$/i.exec(value)?.[1] ?? "";
  if (!allowPath && (url.pathname !== "/" || !["", "/"].includes(rawPath))) return "not include a path";
  return undefined;
}

export function baseUrlRule(allowPath: boolean): string {
  const path = allowPath ? "" : "; no path";
  return `https URL, or http for localhost, 127.0.0.1, or ::1; no credentials, query, or fragment${path}`;
}

export const ID_RULE = "a nonempty string, not . or .., without control characters";

export function validateId(subject: string, value: string): string {
  if (value.length > 0 && value !== "." && value !== ".." && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  throw invalidValue(subject, `be ${ID_RULE}`, echoable(value), `Copy ${subject} from a list command.`, ID_RULE);
}

const MAX_ECHOED_LENGTH = 200;

/**
 * Makes a user value safe to echo in a message: JSON-escapes control characters and quotes, and ends values longer
 * than 200 characters with "...". Every tool uses it for `received` values that may be arbitrary input.
 */
export function echoable(value: string): string {
  const escaped = JSON.stringify(value).slice(1, -1);
  return escaped.length > MAX_ECHOED_LENGTH ? `${escaped.slice(0, MAX_ECHOED_LENGTH - 3)}...` : escaped;
}

/** Joins words as "a", "a and b", or "a, b, and c". */
export function listWords(words: readonly string[], conjunction: "and" | "or"): string {
  if (words.length <= 2) return words.join(` ${conjunction} `);
  return `${words.slice(0, -1).join(", ")}, ${conjunction} ${words.at(-1)}`;
}

/** Reads the text of an input option. A path of - reads stdin. Fails INVALID_ARGUMENT naming the option. */
export function readInput(option: string, path: string): string {
  try {
    return readFileSync(path === "-" ? 0 : path, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw usageError(
      `${option} could not be read${typeof code === "string" ? ` (${code})` : ""}.`,
      "Check that the path exists and is readable, or use - for stdin.",
    );
  }
}

/** Reads and parses a JSON input option. A path of - reads stdin. */
export function readJsonFile(option: string, path: string): unknown {
  const text = readInput(option, path);
  try {
    return JSON.parse(text);
  } catch {
    throw usageError(`${option} must contain valid JSON.`, "Fix the JSON syntax in the input.");
  }
}

export function visibleAsciiConstraint(value: string): string | undefined {
  return /^[!-~]+$/.test(value) ? undefined : "contain only visible ASCII characters without spaces";
}
