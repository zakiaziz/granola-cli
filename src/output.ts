import { ApiError, CliError, asCliError } from "./errors.js";
import type { ColorMode, OutputFormat, ResourceKind } from "./types.js";

let activeFormat: OutputFormat = "json";
let activeColor: ColorMode = "auto";

export function configureOutput(format: OutputFormat, color: ColorMode): void {
  activeFormat = format;
  activeColor = color;
}

export function printResult(
  resource: ResourceKind,
  value: unknown,
  format = activeFormat,
): void {
  process.stdout.write(render(envelope(resource, value), format, process.stdout.isTTY === true));
}

export function printJson(value: unknown): void {
  const document = value && typeof value === "object" && "data" in value && "meta" in value
    ? value
    : { data: value, meta: {} };
  process.stdout.write(render(document, activeFormat, process.stdout.isTTY === true));
}

export function printText(value: string): void {
  process.stdout.write(`${value}\n`);
}

export function printError(error: unknown): void {
  const failure = asCliError(error);
  const retryable = failure instanceof ApiError ? failure.retryable : false;
  process.stderr.write(render({
    error: {
      code: failure.code,
      message: failure.message,
      retryable,
      ...failure.details,
    },
  }, activeFormat, process.stderr.isTTY === true));
}

function render(value: unknown, format: OutputFormat, terminal: boolean): string {
  if (format === "human") {
    const text = renderHuman(value);
    return `${shouldColor(format, terminal) ? `\u001b[38;2;63;185;80m${text}\u001b[0m` : text}\n`;
  }
  const json = JSON.stringify(value, undefined, format === "pretty" ? 2 : undefined);
  const useColor = format === "pretty" && shouldColor(format, terminal);
  return `${useColor ? highlight(json) : json}\n`;
}

function highlight(json: string): string {
  return json.replace(
    /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (token, key: string | undefined, string: string | undefined) => {
      if (key) return `\u001b[38;2;88;166;255m${token}\u001b[0m`;
      if (string) return `\u001b[38;2;63;185;80m${token}\u001b[0m`;
      if (["true", "false", "null"].includes(token)) {
        return `\u001b[38;2;57;197;207m${token}\u001b[0m`;
      }
      return `\u001b[38;2;210;153;34m${token}\u001b[0m`;
    },
  );
}

function envelope(resource: ResourceKind, value: unknown): unknown {
  const collectionKeys: Partial<Record<ResourceKind, string>> = {
    notes: "notes", transcript: "transcript", folders: "folders",
    "audit-events": "events", webhooks: "webhook_endpoints",
  };
  const collectionKey = collectionKeys[resource];
  if (!collectionKey) return { data: value, meta: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(`Granola response for ${resource} is missing collection array ${collectionKey}`, "PROVIDER_ERROR", 1);
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record[collectionKey])) {
    throw new CliError(`Granola response for ${resource} is missing collection array ${collectionKey}`, "PROVIDER_ERROR", 1);
  }
  const nextCursor = record.next_cursor ?? record.cursor ?? null;
  const hasMore = record.has_more ?? record.hasMore ?? (nextCursor !== null);
  const paginationKeys = ["cursor", "next_cursor", "hasMore", "has_more"];
  const providerMeta = Object.fromEntries(
    Object.entries(record).filter(([name]) => name !== collectionKey && !paginationKeys.includes(name)),
  );
  return { data: record[collectionKey], meta: { ...providerMeta, next_cursor: nextCursor, has_more: hasMore } };
}

function shouldColor(_format: OutputFormat, terminal: boolean): boolean {
  return activeColor === "always" || (activeColor === "auto" && terminal && !process.env.NO_COLOR);
}

function renderHuman(value: unknown): string {
  if (value === null) return "No result.";
  if (typeof value === "object" && value && "error" in value) {
    const error = (value as { error: { code?: string; message?: string } }).error;
    return `Error [${error.code ?? "UNKNOWN"}]: ${error.message ?? "Unknown error"}`;
  }
  if (typeof value === "object" && value && "data" in value) {
    return renderHuman((value as { data: unknown }).data);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "No results.";
    const records = value.filter(
      (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
    );
    if (records.length === value.length) {
      const columns = [...new Set(records.flatMap(Object.keys))];
      return [
        columns.join("\t"),
        ...records.map((record) => columns.map((column) => cell(record[column])).join("\t")),
      ].join("\n");
    }
    return value.map(String).join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}: ${cell(item)}`)
      .join("\n");
  }
  return String(value);
}

function cell(value: unknown): string {
  return typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
}
