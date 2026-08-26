import { getString } from "./args.js";
import type { RuntimeContext } from "./auth.js";
import { findEndpoint } from "./endpoints.js";
import { buildRequestPlan } from "./http.js";
import type { GlobalOptions, Operation, ParsedArgs } from "./types.js";
import {
  parseBooleanValue,
  parseCommaList,
  parsePositiveInteger,
  validateDate,
  validateId,
  validateWebhookUrl,
} from "./values.js";

const commonFlags = new Set(["profile", "api-key", "base-url", "format", "help", "version"]);

const commandFlags: Record<string, readonly string[]> = {
  "notes list": [
    "created-before",
    "created-after",
    "updated-after",
    "folder-id",
    "cursor",
    "page-size",
    "all",
    "max-items",
  ],
  "note show": ["include"],
  "note transcript": ["cursor", "page-size", "all", "max-items"],
  "folders list": ["cursor", "page-size", "all", "max-items"],
  "audit list": ["action", "occurred-before", "occurred-after", "cursor", "page-size", "all", "max-items"],
  "webhooks list": [],
  "webhooks create": ["url", "scopes", "events", "folder-ids", "yes", "dry-run"],
  "webhooks update": ["url", "scopes", "events", "folder-ids", "enabled", "yes", "dry-run"],
  "webhooks delete": ["yes", "dry-run"],
};

export function buildGranolaOperation(
  parsed: ParsedArgs,
  options: GlobalOptions,
  context: RuntimeContext,
): Operation {
  rejectUnknownFlags(parsed);
  const match = findEndpoint(parsed.command);
  if (!match) {
    throw new Error(`Unknown command "${parsed.command.join(" ")}". Run granola --help.`);
  }
  assertAllowedFlags(parsed, match.endpoint.name);
  if (options.maxItems !== undefined && !options.all) {
    throw new Error("--max-items requires --all");
  }
  if (options.dryRun && options.format !== "json") {
    throw new Error("--dry-run only supports --format json");
  }

  if (match.params.noteId) validateId(match.params.noteId, "note");
  if (match.params.webhookId) validateId(match.params.webhookId, "webhook");

  const query = buildQuery(match.endpoint.name, parsed, match.endpoint.pagination?.maxPageSize);
  const body = buildBody(match.endpoint.name, parsed);
  const plan = buildRequestPlan({
    endpoint: match.endpoint,
    params: match.params,
    query,
    ...(body !== undefined ? { body } : {}),
    options,
    context,
  });

  return {
    name: match.endpoint.name,
    resource: match.endpoint.resource,
    mutation: match.endpoint.mutation ?? false,
    plan,
  };
}

function buildQuery(
  command: string,
  parsed: ParsedArgs,
  maxPageSize: number | undefined,
): Record<string, string> {
  const query: Record<string, string> = {};
  if (command === "notes list") {
    addDate(query, "created_before", parsed, "created-before");
    addDate(query, "created_after", parsed, "created-after");
    addDate(query, "updated_after", parsed, "updated-after");
    const folderId = getString(parsed.flags, "folder-id");
    if (folderId) query.folder_id = validateId(folderId, "folder");
  }
  if (command === "note show") {
    const include = getString(parsed.flags, "include");
    if (include && include !== "transcript") {
      throw new Error(`Invalid --include "${include}". Use transcript.`);
    }
    if (include) query.include = include;
  }
  if (command === "audit list") {
    const action = getString(parsed.flags, "action");
    if (action && !/^[a-z][a-z0-9_.-]*$/.test(action)) {
      throw new Error("--action must start with a lowercase letter and contain lowercase letters, numbers, dots, hyphens, or underscores");
    }
    if (action) query.action = action;
    addDate(query, "occurred_before", parsed, "occurred-before");
    addDate(query, "occurred_after", parsed, "occurred-after");
  }

  const cursor = getString(parsed.flags, "cursor");
  if (cursor) query.cursor = cursor;
  const pageSize = getString(parsed.flags, "page-size");
  if (pageSize) {
    query.page_size = String(parsePositiveInteger(pageSize, "--page-size", maxPageSize as number));
  }
  return query;
}

function buildBody(command: string, parsed: ParsedArgs): unknown {
  if (command !== "webhooks create" && command !== "webhooks update") return undefined;
  const body: Record<string, unknown> = {};
  const url = getString(parsed.flags, "url");
  if (url !== undefined) body.url = validateWebhookUrl(url);

  const scopesValue = getString(parsed.flags, "scopes");
  if (scopesValue !== undefined) body.scopes = parseScopes(scopesValue);

  const eventsValue = getString(parsed.flags, "events");
  if (eventsValue !== undefined) body.events = parseEvents(eventsValue);

  const folderIdsValue = getString(parsed.flags, "folder-ids");
  if (folderIdsValue !== undefined) {
    const folderIds = parseCommaList(folderIdsValue, "--folder-ids", {
      allowEmpty: command === "webhooks update",
      maximum: 100,
    });
    body.folder_ids = folderIds.map((id) => validateId(id, "folder"));
  }

  const enabledValue = getString(parsed.flags, "enabled");
  if (enabledValue !== undefined) body.enabled = parseBooleanValue(enabledValue, "--enabled");

  if (command === "webhooks create") {
    if (body.url === undefined) throw new Error("webhooks create needs --url");
    if (body.scopes === undefined) throw new Error("webhooks create needs --scopes");
  } else if (Object.keys(body).length === 0) {
    throw new Error("webhooks update needs at least one of --url, --scopes, --events, --folder-ids, or --enabled");
  }
  return body;
}

function parseScopes(value: string): string[] {
  const scopes = parseCommaList(value, "--scopes");
  const allowed = new Set(["personal", "public", "workspace"]);
  for (const scope of scopes) {
    if (!allowed.has(scope)) throw new Error(`Invalid webhook scope "${scope}". Use personal, public, or workspace.`);
  }
  if (scopes.includes("workspace") && scopes.length !== 1) {
    throw new Error("The workspace scope cannot be combined with personal or public");
  }
  return scopes;
}

function parseEvents(value: string): string[] {
  const events = parseCommaList(value, "--events");
  const allowed = new Set(["note.access_granted", "note.edited", "note.generated"]);
  for (const event of events) {
    if (!allowed.has(event)) {
      throw new Error(
        `Invalid webhook event "${event}". Use note.access_granted, note.edited, or note.generated.`,
      );
    }
  }
  return events;
}

function addDate(
  query: Record<string, string>,
  apiName: string,
  parsed: ParsedArgs,
  optionName: string,
): void {
  const value = getString(parsed.flags, optionName);
  if (value) query[apiName] = validateDate(value, `--${optionName}`);
}

function rejectUnknownFlags(parsed: ParsedArgs): void {
  const unknown = parsed.unknownFlags[0];
  if (unknown) throw new Error(`Unknown option --${unknown.name}`);
}

function assertAllowedFlags(parsed: ParsedArgs, command: string): void {
  const allowed = new Set([...commonFlags, ...(commandFlags[command] as readonly string[])]);
  for (const name of Object.keys(parsed.flags)) {
    if (!allowed.has(name)) throw new Error(`--${name} is not valid for "${command}"`);
  }
}
