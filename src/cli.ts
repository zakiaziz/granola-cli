#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin } from "node:process";
import { Writable } from "node:stream";
import { getBoolean, getGlobalOptions, getString, parseArgs } from "./args.js";
import { loadRuntimeContext } from "./auth.js";
import { buildGranolaOperation } from "./commands.js";
import {
  configDir,
  configGet,
  configPath,
  configSet,
  configUnset,
  deleteProfile,
  getActiveProfileName,
  listProfiles,
  profilePath,
  profileExists,
  readConfig,
  requireProfile,
  setActiveProfileName,
  showProfile,
  writeProfile,
} from "./config.js";
import { endpoints } from "./endpoints.js";
import { buildRequestPlan, executeAllPages, executeRequest, renderDryRun } from "./http.js";
import { configureOutput, printError, printJson, printResult, printText } from "./output.js";
import type { GlobalOptions, ParsedArgs, Profile } from "./types.js";
import { environmentValue } from "./util.js";
import { asCliError, CliError } from "./errors.js";
import { completion, scopedHelp } from "./registry.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const initial = preScanPresentation(argv);
  configureOutput(initial.format, initial.color);
  const parsed = parseArgs(argv);
  const options = getGlobalOptions(parsed);
  configureOutput(options.format, options.color);
  if (options.verbose) process.stderr.write(JSON.stringify({ diagnostic: { profile: options.profile ?? "active", format: options.format } }) + "\n");
  const unknown = parsed.unknownFlags[0];
  if (unknown) throw new CliError(`Unknown option --${unknown.name}`);

  if (options.version) {
    printText(version());
    return;
  }
  if (options.help || parsed.command.length === 0) {
    printText(scopedHelp(parsed.command) ?? help());
    return;
  }

  await dispatch(parsed, options);
}

async function dispatch(parsed: ParsedArgs, options: GlobalOptions): Promise<void> {
  const [group, action] = parsed.command;
  if (group === "setup") {
    await runSetup(parsed);
    return;
  }
  if (group === "profiles") {
    runProfiles(parsed);
    return;
  }
  if (group === "config") {
    runConfig(parsed);
    return;
  }
  if (group === "completions") {
    assertCommandLength(parsed, 2, 2, "Usage: granola completions <bash|zsh|fish>");
    assertFlags(parsed, []);
    printText(completion(action as string, listProfiles()));
    return;
  }
  if (group === "auth") {
    await runAuth(parsed, action, options);
    return;
  }

  const context = loadRuntimeContext(options);
  const operation = buildGranolaOperation(parsed, options, context);
  if (operation.mutation && !options.yes && !options.dryRun) {
    if (options.noInput || isCi() || !process.stdin.isTTY) throw new CliError(`"${operation.name}" changes Granola state. Re-run with --dry-run or --yes.`, "CONFIRMATION_REQUIRED", 9);
    const confirmed = await confirmMutation(operation.name, context.profileName ?? "environment/default", operation.plan.url);
    if (!confirmed) throw new CliError("Operation cancelled.", "CONFIRMATION_REQUIRED", 9);
  }
  if (options.dryRun) {
    printJson(renderDryRun(operation.plan));
    return;
  }

  const result = options.all
    ? await executeAllPages(operation.plan, options.maxItems)
    : await executeRequest(operation.plan);
  if (result === null && operation.name.endsWith(" get")) {
    throw new CliError(`Requested ${operation.resource} was not found`, "NOT_FOUND", 5);
  }
  printResult(operation.resource, result, options.format);
}

async function runSetup(parsed: ParsedArgs): Promise<void> {
  assertCommandLength(parsed, 1, 2, "Usage: granola setup [profile] [--api-key KEY] [--base-url URL]");
  assertFlags(parsed, ["api-key", "base-url", "from-env"]);
  const profileName = parsed.command[1] ?? "default";
  if (profileExists(profileName)) throw new CliError(`Profile "${profileName}" already exists. Use granola profiles update ${profileName}.`, "CONFLICT", 6);
  const fromEnvironment = getBoolean(parsed.flags, "from-env");
  let apiKey = getString(parsed.flags, "api-key") ?? (fromEnvironment ? environmentValue("GRANOLA_API_KEY") : undefined);
  const baseUrl = getString(parsed.flags, "base-url") ?? (fromEnvironment ? environmentValue("GRANOLA_BASE_URL") : undefined);

  if (!apiKey && process.stdin.isTTY && !getGlobalOptions(parsed).noInput && !isCi()) apiKey = (await askSecret("Granola API key: ")).trim() || undefined;
  if (!apiKey) throw new CliError("Setup needs --api-key, GRANOLA_API_KEY with --from-env, or interactive input", "CONFIGURATION_ERROR", 3);

  writeProfile(profileName, { apiKey, ...(baseUrl ? { baseUrl } : {}) });
  setActiveProfileName(profileName);
  printJson({ profile: profileName, path: profilePath(profileName), active: true });
}

function runProfiles(parsed: ParsedArgs): void {
  const action = parsed.command[1];
  const name = parsed.command[2];
  if (action === "list") {
    assertCommandLength(parsed, 2, 2, "Usage: granola profiles list");
    assertFlags(parsed, []);
    printJson({ data: listProfiles(), meta: { active_profile: getActiveProfileName() ?? null } });
    return;
  }
  if (action === "get") {
    assertCommandLength(parsed, 3, 3, "Usage: granola profiles get <name>");
    assertFlags(parsed, []);
    printJson(showProfile(name as string));
    return;
  }
  if (action === "create" || action === "update") {
    assertCommandLength(parsed, 3, 3, `Usage: granola profiles ${action} <name> [--api-key KEY] [--base-url URL]`);
    assertFlags(parsed, ["api-key", "base-url"]);
    const fields = profileFields(parsed);
    if (Object.keys(fields).length === 0) {
      throw new CliError(`granola profiles ${action} needs --api-key or --base-url`);
    }
    if (action === "create" && profileExists(name as string)) {
      throw new CliError(`Profile "${name}" already exists. Use granola profiles update ${name}.`, "CONFLICT", 6);
    }
    const profile = action === "update" ? { ...requireProfile(name as string), ...fields } : fields;
    writeProfile(name as string, profile);
    printJson({ profile: name, path: profilePath(name as string) });
    return;
  }
  if (action === "delete") {
    assertCommandLength(parsed, 3, 3, "Usage: granola profiles delete <name>");
    assertFlags(parsed, []);
    deleteProfile(name as string);
    printJson({ deleted: name });
    return;
  }
  if (action === "use") {
    assertCommandLength(parsed, 3, 3, "Usage: granola profiles use <name>");
    assertFlags(parsed, []);
    requireProfile(name as string);
    setActiveProfileName(name as string);
    printJson({ active: name });
    return;
  }
  throw new CliError("Usage: granola profiles <list|get|create|update|delete|use>");
}

function runConfig(parsed: ParsedArgs): void {
  const action = parsed.command[1];
  assertFlags(parsed, []);
  if (action === "path") {
    assertCommandLength(parsed, 2, 2, "Usage: granola config path");
    printJson({ configDir: configDir(), configPath: configPath() });
    return;
  }
  if (action === "get") {
    assertCommandLength(parsed, 2, 2, "Usage: granola config list");
    printJson(readConfig());
    return;
  }
  if (action === "get") {
    assertCommandLength(parsed, 3, 3, "Usage: granola config get <key>");
    printJson({ key: parsed.command[2], value: configGet(parsed.command[2] as string) ?? null });
    return;
  }
  if (action === "set") {
    assertCommandLength(parsed, 4, 4, "Usage: granola config set <key> <value>");
    printJson(configSet(parsed.command[2] as string, parsed.command[3] as string));
    return;
  }
  if (action === "unset") {
    assertCommandLength(parsed, 3, 3, "Usage: granola config unset <key>");
    printJson(configUnset(parsed.command[2] as string));
    return;
  }
  throw new CliError("Usage: granola config <path|list|get|set|unset>");
}

async function runAuth(
  parsed: ParsedArgs,
  action: string | undefined,
  options: GlobalOptions,
): Promise<void> {
  if (action !== "verify") throw new CliError("Usage: granola auth verify");
  assertCommandLength(parsed, 2, 2, "Usage: granola auth verify");
  assertFlags(parsed, ["profile", "api-key", "base-url"]);
  const context = loadRuntimeContext(options);
  const endpoint = endpoints.find((candidate) => candidate.name === "notes list");
  if (!endpoint) throw new CliError("Internal error: notes list endpoint is not registered", "INTERNAL_ERROR", 1);
  const plan = buildRequestPlan({
    endpoint,
    params: {},
    query: { page_size: "1" },
    options,
    context,
  });
  const response = await executeRequest(plan);
  const notes = typeof response === "object" && response !== null && "notes" in response
    ? (response as { notes?: unknown }).notes
    : undefined;
  printJson({
    authenticated: true,
    source: plan.auth.source,
    base_url: context.baseUrl,
    notes_returned: Array.isArray(notes) ? notes.length : null,
  });
}

function profileFields(parsed: ParsedArgs): Profile {
  const apiKey = getString(parsed.flags, "api-key");
  const baseUrl = getString(parsed.flags, "base-url");
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

function assertFlags(parsed: ParsedArgs, allowedNames: readonly string[]): void {
  const unknown = parsed.unknownFlags[0];
  if (unknown) throw new CliError(`Unknown option --${unknown.name}`);
  const allowed = new Set([...allowedNames, "profile", "timeout", "format", "color", "quiet", "verbose", "no-input", "help", "version"]);
  for (const name of Object.keys(parsed.flags)) {
    if (!allowed.has(name)) throw new CliError(`--${name} is not valid for "${parsed.command.join(" ")}"`);
  }
}

function assertCommandLength(
  parsed: ParsedArgs,
  minimum: number,
  maximum: number,
  usage: string,
): void {
  if (parsed.command.length < minimum || parsed.command.length > maximum) throw new CliError(usage);
}

async function askSecret(prompt: string): Promise<string> {
  let muted = false;
  const silentOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stderr.write(chunk, encoding);
      callback();
    },
  });
  const readline = createInterface({ input: stdin, output: silentOutput, terminal: true });
  try {
    process.stderr.write(prompt);
    muted = true;
    const answer = await readline.question("");
    muted = false;
    process.stderr.write("\n");
    return answer;
  } finally {
    readline.close();
  }
}

function version(): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const packagePath = join(currentDirectory, "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string") throw new CliError(`Missing version in ${packagePath}`, "INTERNAL_ERROR", 1);
  return `granola ${packageJson.version}`;
}

function help(): string {
  return `granola ${version()}

Agent-friendly access to the Granola API.

Usage:
  granola <command> [options]

Authentication and configuration:
  granola setup [profile] [--api-key KEY] [--base-url URL]
  granola profiles list
  granola profiles get <name>
  granola profiles create <name> [--api-key KEY] [--base-url URL]
  granola profiles update <name> [--api-key KEY] [--base-url URL]
  granola profiles delete <name>
  granola profiles use <name>
  granola config path
  granola config list
  granola config get <key>
  granola config set <key> <value>
  granola config unset <key>
  granola auth verify

Notes, transcripts, folders, and audit events:
  granola notes list [--created-before DATE] [--created-after DATE] [--updated-after DATE]
                     [--folder-id ID] [--cursor CURSOR] [--page-size N] [--all]
  granola notes get <note-id> [--include transcript]
  granola notes transcript get <note-id> [--cursor CURSOR] [--page-size N] [--all]
  granola folders list [--cursor CURSOR] [--page-size N] [--all]
  granola audit-events list [--action ACTION] [--occurred-before DATE] [--occurred-after DATE]
                     [--cursor CURSOR] [--page-size N] [--all]

Webhooks:
  granola webhooks list
  granola webhooks create --url URL --scope SCOPE [--scope SCOPE] [--event EVENT [--event EVENT]]
                          [--folder-id ID [--folder-id ID]] (--dry-run | --yes)
  granola webhooks update <webhook-id> [--url URL] [--scope SCOPE [--scope SCOPE]]
                          [--event EVENT [--event EVENT]] [--folder-id ID [--folder-id ID]]
                          [--enabled true|false] (--dry-run | --yes)
  granola webhooks delete <webhook-id> (--dry-run | --yes)

Global options:
  --profile <name>       Select a saved profile.
  --api-key <key>        Override the Granola API key.
  --base-url <url>       Override https://public-api.granola.ai.
  --format <format>      Use json, pretty, or human. Default: json.
  --color <mode>       Use auto, always, or never. Default: auto.\
  --quiet, -q           Suppress progress and notices.\
  --verbose, -v         Print redacted diagnostics to stderr.\
  --no-input            Never prompt for input.
  --all                  Follow every page for a paginated command.
  --max-items <number>   Stop --all after this many items and return a cursor.
  --dry-run              Print a redacted webhook request without sending it.
  --yes, -y              Confirm a webhook mutation.
  --help, -h             Show help.
  --version          Show the version.
`;
}

function isCi(): boolean { const value=process.env.CI?.trim().toLowerCase(); return value!==undefined&&value!==""&&value!=="0"&&value!=="false"; }

function preScanPresentation(argv: readonly string[]): { format: GlobalOptions["format"]; color: GlobalOptions["color"] } {
  const read = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === `--${name}`) return argv[index + 1];
      if (argv[index]?.startsWith(prefix)) return argv[index]?.slice(prefix.length);
    }
    return undefined;
  };
  const format = read("format");
  const color = read("color");
  return { format: format === "pretty" || format === "human" ? format : "json", color: color === "always" || color === "never" ? color : "auto" };
}

async function confirmMutation(command: string, profile: string, target: string): Promise<boolean> {
  process.stderr.write(`Confirm Granola mutation\nProfile: ${profile}\nTarget: ${target}\nEffect: ${command} changes remote Granola state\nContinue? [y/N] `);
  const readline = createInterface({ input: stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await readline.question("")).trim()); } finally { readline.close(); }
}

process.on("SIGINT", () => { printError(new CliError("Interrupted by user", "INTERRUPTED", 130)); process.exit(130); });
main().catch((error: unknown) => {
  const failure = asCliError(error);
  printError(failure);
  process.exitCode = failure.exitCode;
});
