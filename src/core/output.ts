// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { asCliError, CliError, type PagePartial, type StepPartial } from "./errors.js";
import type { ColorMode, OutputFormat } from "./types.js";
import { isRecord } from "./values.js";

const RESET = "\u001b[0m";
const BLUE = "\u001b[38;2;88;166;255m";
const GREEN = "\u001b[38;2;63;185;80m";
const CYAN = "\u001b[38;2;57;197;207m";
const YELLOW = "\u001b[38;2;210;153;34m";
const RED = "\u001b[38;2;248;81;73m";
const GRAY = "\u001b[38;2;139;148;158m";
const MAX_CELL_LENGTH = 60;

export interface Presentation {
  bin: string;
  format: OutputFormat;
  color: ColorMode;
  verbose: boolean;
}

let active: Presentation = { bin: "", format: "json", color: "auto", verbose: false };

export function configureOutput(presentation: Presentation): void {
  active = presentation;
}

export function printResult(data: unknown, meta: Record<string, unknown> = {}): void {
  const colored = colorApplies(process.stdout);
  if (active.format === "human") {
    process.stdout.write(`${renderHuman(data, colored)}${humanMeta(meta)}\n`);
    return;
  }
  process.stdout.write(renderJson({ data, meta }, colored));
}

export function printRaw(value: unknown): void {
  const colored = colorApplies(process.stdout);
  if (active.format === "human") {
    process.stdout.write(`${renderHuman(value, colored)}\n`);
    return;
  }
  process.stdout.write(renderJson(value, colored));
}

export function printText(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function printDiagnostic(event: string, fields: Record<string, unknown>): void {
  if (!active.verbose) return;
  if (active.format !== "human") {
    process.stderr.write(`${JSON.stringify({ diagnostic: { event, ...fields } })}\n`);
    return;
  }
  const { method, url, ...rest } = fields;
  const head = event === "request" ? ` ${String(method)} ${String(url)}` : "";
  const pairs = Object.entries(event === "request" ? rest : fields)
    .map(([key, value]) => ` ${key}=${value === null || value === undefined ? "none" : String(value)}`)
    .join("");
  process.stderr.write(`${active.bin}: ${event}${head}${pairs}\n`);
}

export function printError(error: unknown): void {
  process.stderr.write(errorText(asCliError(error)));
}

export function exitInterrupted(): void {
  process.exitCode = 130;
  process.stderr.write(errorText(new CliError("INTERRUPTED", "Interrupted.")), () => process.exit(130));
}

function errorText(failure: CliError): string {
  const colored = colorApplies(process.stderr);
  if (active.format === "human") return renderHumanError(failure, colored);
  return renderJson({ error: errorBody(failure) }, colored);
}

function errorBody(failure: CliError): Record<string, unknown> {
  const { hint, retryable, outcome, provider, details, partial } = failure.extra;
  return {
    code: failure.code,
    message: failure.message,
    ...(hint ? { hint } : {}),
    retryable: retryable ?? false,
    ...(outcome ? { outcome } : {}),
    ...(provider ? { provider } : {}),
    ...(details ? { details } : {}),
    ...(partial ? { partial } : {}),
  };
}

function renderHumanError(failure: CliError, colored: boolean): string {
  const lines = [`${paint(`Error [${failure.code}]:`, RED, colored)} ${failure.message}`];
  if (failure.extra.hint) lines.push(`${paint("Hint:", GRAY, colored)} ${failure.extra.hint}`);
  const provider = failure.extra.provider;
  const parts = [
    ...(provider?.status === undefined ? [] : [`HTTP ${provider.status}`]),
    ...(provider?.code === undefined ? [] : [`code ${provider.code}`]),
    ...(provider?.request_id === undefined ? [] : [`request ${provider.request_id}`]),
  ];
  if (parts.length > 0) lines.push(`Provider: ${parts.join(", ")}.`);
  if (failure.extra.partial) lines.push(...humanPartial(failure.extra.partial, colored));
  return `${lines.join("\n")}\n`;
}

/** Reports what completed before a partial failure, so a human can act on the resume hint without losing results (CLI-ERR-4). */
function humanPartial(partial: StepPartial | PagePartial, colored: boolean): string[] {
  if ("data" in partial) {
    const resume = partial.next_cursor === null ? "none" : partial.next_cursor;
    return [
      `${paint("Partial:", GRAY, colored)} ${partial.data.length} items read before the failure. next_cursor: ${resume}.`,
      renderHumanCollection(partial.data, colored),
    ];
  }
  const label = (text: string): string => paint(text, GRAY, colored);
  return [
    ...partial.completed.map((item) => `${label("Completed:")} ${item.step}.`),
    ...partial.failed.map((item) => `${label("Failed:")} ${item.step}: [${item.error.code}] ${item.error.message}`),
    ...partial.not_attempted.map((item) => `${label("Not attempted:")} ${item.step}.`),
  ];
}

function colorApplies(stream: NodeJS.WriteStream): boolean {
  if (active.color === "always") return true;
  if (active.color === "never") return false;
  return stream.isTTY === true && !process.env.NO_COLOR;
}

function paint(text: string, color: string, colored: boolean): string {
  return colored ? `${color}${text}${RESET}` : text;
}

function renderJson(value: unknown, colored: boolean): string {
  if (active.format === "json") return `${JSON.stringify(value)}\n`;
  const text = JSON.stringify(value, null, 2);
  return `${colored ? highlight(text) : text}\n`;
}

function highlight(json: string): string {
  return json.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (token: string, quoted: string | undefined, colon: string | undefined, literal: string | undefined) => {
      if (quoted) return colon ? `${BLUE}${quoted}${RESET}${colon}` : `${GREEN}${quoted}${RESET}`;
      if (literal) return `${CYAN}${token}${RESET}`;
      return `${YELLOW}${token}${RESET}`;
    },
  );
}

function humanMeta(meta: Record<string, unknown>): string {
  if (meta.has_more !== true) return "";
  return `\n\nnext_cursor: ${String(meta.next_cursor)}\nhas_more: true`;
}

function renderHuman(value: unknown, colored: boolean): string {
  if (value === null || value === undefined) return "No result.";
  if (Array.isArray(value)) return renderHumanCollection(value, colored);
  if (isRecord(value)) return renderHumanObject(value, colored);
  return String(value);
}

function renderHumanCollection(items: unknown[], colored: boolean): string {
  if (items.length === 0) return "No results.";
  if (!items.every(isRecord)) return items.map(nested).join("\n");
  const columns = [...new Set(items.flatMap((item) => Object.keys(item)))];
  const rows = items.map((item) => columns.map((column) => cell(item[column])));
  const widths = columns.map((column, index) =>
    rows.reduce((width, row) => Math.max(width, row[index]?.length ?? 0), column.length),
  );
  const line = (cells: string[]): string =>
    cells
      .map((text, index) => text.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return [paint(line(columns), BLUE, colored), ...rows.map(line)].join("\n");
}

function renderHumanObject(value: Record<string, unknown>, colored: boolean): string {
  const entries = Object.entries(value);
  if (entries.length === 0) return "No result.";
  const width = entries.reduce((longest, [key]) => Math.max(longest, key.length + 1), 0);
  return entries
    .map(([key, item]) => `${paint(`${key}:`, BLUE, colored)}${" ".repeat(width - key.length - 1)} ${nested(item)}`.trimEnd())
    .join("\n");
}

function cell(value: unknown): string {
  const text = nested(value).replace(/\s+/g, " ");
  return text.length > MAX_CELL_LENGTH ? `${text.slice(0, MAX_CELL_LENGTH - 3)}...` : text;
}

function nested(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
