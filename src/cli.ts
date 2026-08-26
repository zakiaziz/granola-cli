#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
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
import { printJson, printResult, printText } from "./output.js";
import type { GlobalOptions, ParsedArgs, Profile } from "./types.js";
import { environmentValue } from "./util.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  const options = getGlobalOptions(parsed);
  const unknown = parsed.unknownFlags[0];
  if (unknown) throw new Error(`Unknown option --${unknown.name}`);

  if (options.version) {
    printText(version());
    return;
  }
  if (options.help || parsed.command.length === 0) {
    printText(help());
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
  if (group === "auth") {
    await runAuth(parsed, action, options);
    return;
  }

  const context = loadRuntimeContext(options);
  const operation = buildGranolaOperation(parsed, options, context);
  if (operation.mutation && !options.yes && !options.dryRun) {
    throw new Error(
      `"${operation.name}" changes Granola state. Re-run with --dry-run or --yes.`,
    );
  }
  if (options.dryRun) {
    printJson(renderDryRun(operation.plan));
    return;
  }

  const result = options.all
    ? await executeAllPages(operation.plan, options.maxItems)
    : await executeRequest(operation.plan);
  printResult(operation.resource, result, options.format);
}

async function runSetup(parsed: ParsedArgs): Promise<void> {
  assertCommandLength(parsed, 1, 2, "Usage: granola setup [profile] [--api-key KEY] [--base-url URL]");
  assertFlags(parsed, ["api-key", "base-url", "from-env"]);
  const profileName = parsed.command[1] ?? "default";
  const fromEnvironment = getBoolean(parsed.flags, "from-env");
  let apiKey = getString(parsed.flags, "api-key") ?? (fromEnvironment ? environmentValue("GRANOLA_API_KEY") : undefined);
  const baseUrl = getString(parsed.flags, "base-url") ?? (fromEnvironment ? environmentValue("GRANOLA_BASE_URL") : undefined);

  if (!apiKey && process.stdin.isTTY) apiKey = (await askSecret("Granola API key: ")).trim() || undefined;
  if (!apiKey) throw new Error("Setup needs --api-key, GRANOLA_API_KEY with --from-env, or interactive input");

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
    printJson({ active: getActiveProfileName() ?? null, profiles: listProfiles() });
    return;
  }
  if (action === "show") {
    assertCommandLength(parsed, 3, 3, "Usage: granola profiles show <name>");
    assertFlags(parsed, []);
    printJson(showProfile(name as string));
    return;
  }
  if (action === "create" || action === "update") {
    assertCommandLength(parsed, 3, 3, `Usage: granola profiles ${action} <name> [--api-key KEY] [--base-url URL]`);
    assertFlags(parsed, ["api-key", "base-url"]);
    const fields = profileFields(parsed);
    if (Object.keys(fields).length === 0) {
      throw new Error(`granola profiles ${action} needs --api-key or --base-url`);
    }
    if (action === "create" && profileExists(name as string)) {
      throw new Error(`Profile "${name}" already exists. Use granola profiles update ${name}.`);
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
  throw new Error("Usage: granola profiles <list|show|create|update|delete|use>");
}

function runConfig(parsed: ParsedArgs): void {
  const action = parsed.command[1];
  assertFlags(parsed, []);
  if (action === "path") {
    assertCommandLength(parsed, 2, 2, "Usage: granola config path");
    printJson({ configDir: configDir(), configPath: configPath() });
    return;
  }
  if (action === "show") {
    assertCommandLength(parsed, 2, 2, "Usage: granola config show");
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
  throw new Error("Usage: granola config <path|show|get|set|unset>");
}

async function runAuth(
  parsed: ParsedArgs,
  action: string | undefined,
  options: GlobalOptions,
): Promise<void> {
  if (action !== "verify") throw new Error("Usage: granola auth verify");
  assertCommandLength(parsed, 2, 2, "Usage: granola auth verify");
  assertFlags(parsed, ["profile", "api-key", "base-url"]);
  const context = loadRuntimeContext(options);
  const endpoint = endpoints.find((candidate) => candidate.name === "notes list");
  if (!endpoint) throw new Error("Internal error: notes list endpoint is not registered");
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
  if (unknown) throw new Error(`Unknown option --${unknown.name}`);
  const allowed = new Set(allowedNames);
  for (const name of Object.keys(parsed.flags)) {
    if (!allowed.has(name)) throw new Error(`--${name} is not valid for "${parsed.command.join(" ")}"`);
  }
}

function assertCommandLength(
  parsed: ParsedArgs,
  minimum: number,
  maximum: number,
  usage: string,
): void {
  if (parsed.command.length < minimum || parsed.command.length > maximum) throw new Error(usage);
}

async function askSecret(prompt: string): Promise<string> {
  let muted = false;
  const silentOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) stdout.write(chunk, encoding);
      callback();
    },
  });
  const readline = createInterface({ input: stdin, output: silentOutput, terminal: true });
  try {
    stdout.write(prompt);
    muted = true;
    const answer = await readline.question("");
    muted = false;
    stdout.write("\n");
    return answer;
  } finally {
    readline.close();
  }
}

function version(): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const packagePath = join(currentDirectory, "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string") throw new Error(`Missing version in ${packagePath}`);
  return packageJson.version;
}

function help(): string {
  return `granola ${version()}

Agent-friendly access to the Granola API.

Usage:
  granola <command> [options]

Authentication and configuration:
  granola setup [profile] [--api-key KEY] [--base-url URL]
  granola profiles list
  granola profiles show <name>
  granola profiles create <name> [--api-key KEY] [--base-url URL]
  granola profiles update <name> [--api-key KEY] [--base-url URL]
  granola profiles delete <name>
  granola profiles use <name>
  granola config path
  granola config show
  granola config get <key>
  granola config set <key> <value>
  granola config unset <key>
  granola auth verify

Notes, transcripts, folders, and audit events:
  granola notes list [--created-before DATE] [--created-after DATE] [--updated-after DATE]
                     [--folder-id ID] [--cursor CURSOR] [--page-size N] [--all]
  granola note show <note-id> [--include transcript]
  granola note transcript <note-id> [--cursor CURSOR] [--page-size N] [--all]
  granola folders list [--cursor CURSOR] [--page-size N] [--all]
  granola audit list [--action ACTION] [--occurred-before DATE] [--occurred-after DATE]
                     [--cursor CURSOR] [--page-size N] [--all]

Webhooks:
  granola webhooks list
  granola webhooks create --url URL --scopes SCOPE[,SCOPE] [--events EVENT[,EVENT]]
                          [--folder-ids ID[,ID]] (--dry-run | --yes)
  granola webhooks update <webhook-id> [--url URL] [--scopes SCOPE[,SCOPE]]
                          [--events EVENT[,EVENT]] [--folder-ids ID[,ID]]
                          [--enabled true|false] (--dry-run | --yes)
  granola webhooks delete <webhook-id> (--dry-run | --yes)

Global options:
  --profile <name>       Select a saved profile.
  --api-key <key>        Override the Granola API key.
  --base-url <url>       Override https://public-api.granola.ai.
  --format <format>      Use json, text, or markdown. Default: json.
  --all                  Follow every page for a paginated command.
  --max-items <number>   Stop --all after this many items and return a cursor.
  --dry-run              Print a redacted webhook request without sending it.
  --yes, -y              Confirm a webhook mutation.
  --help, -h             Show help.
  --version, -v          Show the version.
`;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
