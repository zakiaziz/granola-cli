import type { GlobalOptions, OutputFormat, ParsedArgs, UnknownFlag } from "./types.js";
import { parsePositiveInteger } from "./values.js";

const valueFlags = new Set([
  "profile",
  "api-key",
  "base-url",
  "format",
  "max-items",
  "created-before",
  "created-after",
  "updated-after",
  "folder-id",
  "cursor",
  "page-size",
  "include",
  "action",
  "occurred-before",
  "occurred-after",
  "url",
  "scopes",
  "events",
  "folder-ids",
  "enabled",
]);

const booleanFlags = new Set([
  "yes",
  "dry-run",
  "all",
  "help",
  "version",
  "from-env",
]);

const aliases: Record<string, string> = {
  h: "help",
  v: "version",
  y: "yes",
};

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const command: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const unknownFlags: UnknownFlag[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (arg === "--") {
      command.push(...argv.slice(index + 1));
      break;
    }

    if (!arg.startsWith("-") || arg === "-") {
      command.push(arg);
      continue;
    }

    const parsed = parseFlagToken(arg);
    const name = aliases[parsed.name] ?? parsed.name;

    if (booleanFlags.has(name)) {
      setUniqueFlag(flags, name, parseBooleanFlag(name, parsed.value));
      continue;
    }

    if (valueFlags.has(name)) {
      const value = parsed.value ?? argv[index + 1];
      if (value === undefined || (parsed.value === undefined && value.startsWith("-"))) {
        throw new Error(`Missing value for --${name}`);
      }
      if (value === "" && name !== "folder-ids") {
        throw new Error(`--${name} cannot be empty`);
      }
      if (parsed.value === undefined) index += 1;
      setUniqueFlag(flags, name, value);
      continue;
    }

    const value = parsed.value ?? nextFlagValue(argv[index + 1]);
    if (parsed.value === undefined && value !== true) index += 1;
    unknownFlags.push({ name, value });
  }

  return { command, flags, unknownFlags };
}

export function getGlobalOptions(parsed: ParsedArgs): GlobalOptions {
  const formatValue = getString(parsed.flags, "format") ?? "json";
  if (!isOutputFormat(formatValue)) {
    throw new Error(`Invalid --format "${formatValue}". Use json, text, or markdown.`);
  }

  const maxItemsValue = getString(parsed.flags, "max-items");
  const profile = getString(parsed.flags, "profile");
  const apiKey = getString(parsed.flags, "api-key");
  const baseUrl = getString(parsed.flags, "base-url");
  return {
    ...(profile ? { profile } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    format: formatValue,
    all: getBoolean(parsed.flags, "all"),
    ...(maxItemsValue === undefined
      ? {}
      : { maxItems: parsePositiveInteger(maxItemsValue, "--max-items") }),
    yes: getBoolean(parsed.flags, "yes"),
    dryRun: getBoolean(parsed.flags, "dry-run"),
    help: getBoolean(parsed.flags, "help"),
    version: getBoolean(parsed.flags, "version"),
  };
}

export function getString(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function getBoolean(
  flags: Record<string, string | boolean>,
  name: string,
): boolean {
  return flags[name] === true;
}

function parseFlagToken(arg: string): { name: string; value?: string } {
  const trimmed = arg.replace(/^-+/, "");
  const separator = trimmed.indexOf("=");
  if (separator === -1) return { name: trimmed };
  return { name: trimmed.slice(0, separator), value: trimmed.slice(separator + 1) };
}

function parseBooleanFlag(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid boolean value "${value}" for --${name}. Use true or false.`);
}

function nextFlagValue(value: string | undefined): string | boolean {
  if (value === undefined || value.startsWith("-")) return true;
  return value;
}

function setUniqueFlag(
  flags: Record<string, string | boolean>,
  name: string,
  value: string | boolean,
): void {
  if (Object.hasOwn(flags, name)) {
    throw new Error(`Option --${name} may only be provided once`);
  }
  flags[name] = value;
}

function isOutputFormat(value: string): value is OutputFormat {
  return value === "json" || value === "text" || value === "markdown";
}
