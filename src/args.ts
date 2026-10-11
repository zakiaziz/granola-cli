import { CliError } from "./errors.js";
import type { GlobalOptions, OutputFormat, ParsedArgs, UnknownFlag } from "./types.js";
import { parsePositiveInteger } from "./values.js";

const valueFlags = new Set([
  "profile", "api-key", "base-url", "format", "color", "timeout", "max-items",
  "created-before", "created-after", "updated-after", "folder-id", "cursor",
  "page-size", "include", "action", "occurred-before", "occurred-after",
  "url", "scope", "event", "enabled",
]);
const booleanFlags = new Set([
  "yes", "dry-run", "all", "help", "version", "quiet", "verbose", "no-input",
  "from-env", "clear-folder-ids",
]);
const repeatableFlags = new Set(["scope", "event", "folder-id"]);
const aliases: Record<string, string> = { h: "help", q: "quiet", v: "verbose", y: "yes" };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const command: string[] = [];
  const flags: ParsedArgs["flags"] = {};
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
    if (arg.startsWith("---") || (arg.startsWith("--") && parsed.name.length === 1) || (!arg.startsWith("--") && !(parsed.name in aliases))) {
      throw new CliError(`Unknown option ${arg}`);
    }
    const name = arg.startsWith("--") ? parsed.name : aliases[parsed.name]!;

    if (booleanFlags.has(name)) {
      setFlag(flags, name, parseBoolean(name, parsed.value));
      continue;
    }
    if (valueFlags.has(name)) {
      const value = parsed.value ?? argv[index + 1];
      if (
        value === undefined
        || (parsed.value === undefined && value.startsWith("-") && value !== "-")
      ) {
        throw new CliError(`Missing value for --${name}`);
      }
      if (value === "") throw new CliError(`--${name} cannot be empty`);
      if (parsed.value === undefined) index += 1;
      setFlag(flags, name, value);
      continue;
    }

    const value = parsed.value ?? nextFlagValue(argv[index + 1]);
    if (parsed.value === undefined && value !== true) index += 1;
    unknownFlags.push({ name, value });
  }
  return { command, flags, unknownFlags };
}

export function getGlobalOptions(parsed: ParsedArgs): GlobalOptions {
  const format = (choice(parsed.flags, "format", ["json", "pretty", "human"]) ?? "json") as OutputFormat;
  const color = (choice(parsed.flags, "color", ["auto", "always", "never"]) ?? "auto") as GlobalOptions["color"];
  if (getBoolean(parsed.flags, "quiet") && getBoolean(parsed.flags, "verbose")) {
    throw new CliError("--quiet and --verbose cannot be used together");
  }
  const profile = getString(parsed.flags, "profile");
  const apiKey = getString(parsed.flags, "api-key");
  const baseUrl = getString(parsed.flags, "base-url");
  const maxItems = getString(parsed.flags, "max-items");

  return {
    ...(profile ? { profile } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    format,
    color,
    all: getBoolean(parsed.flags, "all"),
    ...(maxItems ? { maxItems: parsePositiveInteger(maxItems, "--max-items") } : {}),
    yes: getBoolean(parsed.flags, "yes"),
    quiet: getBoolean(parsed.flags, "quiet"),
    verbose: getBoolean(parsed.flags, "verbose"),
    noInput: getBoolean(parsed.flags, "no-input"),
    dryRun: getBoolean(parsed.flags, "dry-run"),
    help: getBoolean(parsed.flags, "help"),
    version: getBoolean(parsed.flags, "version"),
    timeoutMs: parseDuration(getString(parsed.flags, "timeout") ?? "30s"),
  };
}

export function getString(flags: ParsedArgs["flags"], name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function getStrings(flags: ParsedArgs["flags"], name: string): string[] {
  const value = flags[name];
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}

export function getBoolean(flags: ParsedArgs["flags"], name: string): boolean {
  return flags[name] === true;
}

function parseFlagToken(arg: string): { name: string; value?: string } {
  const token = arg.replace(/^-+/, "");
  const separator = token.indexOf("=");
  return separator < 0
    ? { name: token }
    : { name: token.slice(0, separator), value: token.slice(separator + 1) };
}

function parseBoolean(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new CliError(`Invalid boolean value ${JSON.stringify(value)} for --${name}`);
}

function nextFlagValue(value: string | undefined): string | boolean {
  return value === undefined || value.startsWith("-") ? true : value;
}

function setFlag(
  flags: ParsedArgs["flags"],
  name: string,
  value: string | boolean,
): void {
  if (repeatableFlags.has(name)) {
    const current = flags[name];
    if (Array.isArray(current)) current.push(String(value));
    else flags[name] = [String(value)];
    return;
  }
  if (name in flags) throw new CliError(`Option --${name} may only be provided once`);
  flags[name] = value;
}

function choice(
  flags: ParsedArgs["flags"],
  name: string,
  allowed: readonly string[],
): string | undefined {
  const value = getString(flags, name);
  if (value !== undefined && !allowed.includes(value)) {
    throw new CliError(
      `Invalid --${name} value ${JSON.stringify(value)}. Use ${allowed.join(", ")}.`,
    );
  }
  return value;
}

function parseDuration(value: string): number {
  const match = /^([1-9][0-9]*)(ms|s|m)$/.exec(value);
  if (!match) throw new CliError("--timeout must be a positive duration with ms, s, or m");
  const milliseconds = Number(match[1]) * (match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1);
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 2_147_483_647) {
    throw new CliError("--timeout is outside the supported range");
  }
  return milliseconds;
}
