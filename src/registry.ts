import type { RequestSpec, ResourceCommand } from "./core/provider.js";
import { dateOption, type ArgumentSpec, type Context, type GroupSpec } from "./core/registry.js";
import { invalidValue, missingFields, redactCredentials, validateId } from "./core/values.js";

const PROVIDER_ORDER = "Order is set by Granola and is undocumented.";
const WEBHOOK_SCOPES = ["personal", "public", "workspace"];
const WEBHOOK_EVENTS = ["note.access_granted", "note.edited", "note.generated"];
const NOTE_ID: ArgumentSpec = { name: "NOTE_ID", description: "Note ID.", check: (value) => validateId("NOTE_ID", value) };
const WEBHOOK_ID: ArgumentSpec = {
  name: "WEBHOOK_ID",
  description: "Webhook endpoint ID.",
  check: (value) => validateId("WEBHOOK_ID", value),
};

export const groups: GroupSpec[] = [
  { path: ["audit-events"], summary: "List workspace audit events.", title: "Inspect workspace audit events." },
  { path: ["folders"], summary: "List folders.", title: "Inspect folders." },
  { path: ["notes"], summary: "List and get meeting notes and transcripts.", title: "Inspect meeting notes and transcripts." },
  { path: ["notes", "transcript"], summary: "Get note transcripts.", title: "Inspect note transcripts." },
  { path: ["webhooks"], summary: "List, create, update, and delete webhook endpoints.", title: "Manage webhook endpoints." },
];

export const commands: ResourceCommand[] = [
  {
    path: ["notes", "list"],
    summary: "List meeting notes.",
    arguments: [],
    options: [
      dateOption("created-before", "Notes created before", "undocumented"),
      dateOption("created-after", "Notes created after", "undocumented"),
      dateOption("updated-after", "Notes updated after", "undocumented"),
      {
        name: "folder-id",
        placeholder: "ID",
        type: "string",
        description: "Notes in this folder and its child folders. Find IDs with 'folders list'.",
      },
    ],
    effects: { kind: "read" },
    output: "Collection envelope. data is an array of notes; meta holds next_cursor and has_more.",
    method: "GET",
    collectionKey: "notes",
    pagination: { max: 30, default: 10, ordering: PROVIDER_ORDER },
    examples: ["granola notes list --created-after 2026-08-01", "granola notes list --all --max-items 100 --format human"],
    request: (context) => ({
      path: "/v1/notes",
      query: [
        ...optionQuery(context, "created-before", "created_before"),
        ...optionQuery(context, "created-after", "created_after"),
        ...optionQuery(context, "updated-after", "updated_after"),
        ...optionQuery(context, "folder-id", "folder_id", (value) => validateId("--folder-id", value)),
      ],
    }),
  },
  {
    path: ["notes", "get"],
    summary: "Get one meeting note.",
    arguments: [NOTE_ID],
    options: [
      {
        name: "include",
        placeholder: "RESOURCE",
        type: "enum",
        choices: ["transcript"],
        description:
          "Include related data inline. Granola answers 413 TRANSCRIPT_TOO_LARGE for large transcripts; use 'notes transcript get' instead.",
      },
    ],
    effects: { kind: "read" },
    output: "Resource envelope. data is the note object; meta is empty.",
    method: "GET",
    emptyIsNotFound: true,
    examples: ["granola notes get not_1d3tmYTlCICgjy", "granola notes get not_1d3tmYTlCICgjy --include transcript"],
    request: (context) => ({
      path: `/v1/notes/${encodedId(context)}`,
      query: optionQuery(context, "include", "include"),
    }),
  },
  {
    path: ["notes", "transcript", "get"],
    summary: "Get the transcript of one note.",
    arguments: [NOTE_ID],
    options: [],
    effects: { kind: "read" },
    output: "Collection envelope. data is an array of transcript items; meta holds next_cursor and has_more.",
    method: "GET",
    collectionKey: "transcript",
    pagination: { max: 100, default: 50, ordering: PROVIDER_ORDER },
    examples: ["granola notes transcript get not_1d3tmYTlCICgjy --all --format human"],
    request: (context) => ({ path: `/v1/notes/${encodedId(context)}/transcript` }),
  },
  {
    path: ["folders", "list"],
    summary: "List folders.",
    arguments: [],
    options: [],
    effects: { kind: "read" },
    output: "Collection envelope. data is an array of folders; meta holds next_cursor and has_more.",
    method: "GET",
    collectionKey: "folders",
    pagination: { max: 30, default: 10, ordering: "Alphabetical by folder name; the CLI does not sort." },
    examples: ["granola folders list --all"],
    request: () => ({ path: "/v1/folders" }),
  },
  {
    path: ["audit-events", "list"],
    summary: "List workspace audit events.",
    arguments: [],
    options: [
      {
        name: "action",
        placeholder: "ACTION",
        type: "string",
        description: "Events whose action equals ACTION or starts with ACTION and a dot, such as workspace.",
      },
      dateOption("occurred-before", "Events that occurred before", "undocumented"),
      dateOption("occurred-after", "Events that occurred after", "undocumented"),
    ],
    effects: { kind: "read" },
    output:
      "Collection envelope. data is an array of audit events; meta holds next_cursor and has_more. Granola keeps audit events for a limited retention window.",
    method: "GET",
    collectionKey: "events",
    pagination: { max: 30, default: 30, ordering: PROVIDER_ORDER },
    examples: ["granola audit-events list --action workspace --occurred-after 2026-09-01"],
    request: (context) => ({
      path: "/v1/audit",
      query: [
        ...optionQuery(context, "action", "action", validateAction),
        ...optionQuery(context, "occurred-before", "occurred_before"),
        ...optionQuery(context, "occurred-after", "occurred_after"),
      ],
    }),
  },
  {
    path: ["webhooks", "list"],
    summary: "List webhook endpoints.",
    arguments: [],
    options: [],
    effects: { kind: "read" },
    output: "Collection envelope. data is an array of webhook endpoints; meta is empty.",
    method: "GET",
    collectionKey: "webhook_endpoints",
    unpaginated: "Not paginated. Granola returns the full list in one response; meta is empty.",
    examples: ["granola webhooks list --format human"],
    request: () => ({ path: "/v1/webhook-endpoints" }),
  },
  {
    path: ["webhooks", "create"],
    summary: "Create a webhook endpoint.",
    arguments: [],
    options: [
      { name: "url", placeholder: "URL", type: "string", required: true, description: "HTTPS URL that receives events." },
      {
        name: "scope",
        placeholder: "SCOPE",
        type: "enum",
        choices: WEBHOOK_SCOPES,
        repeatable: true,
        required: true,
        description: "Note scope to deliver. workspace cannot be combined with personal or public.",
      },
      {
        name: "event",
        placeholder: "EVENT",
        type: "enum",
        choices: WEBHOOK_EVENTS,
        repeatable: true,
        description: "Event type to deliver.",
      },
      { name: "folder-id", placeholder: "ID", type: "string", repeatable: true, description: "Only deliver notes in this folder." },
    ],
    effects: {
      kind: "remote-mutation",
      summary:
        "Creates a webhook endpoint. The response includes signing_secret, which Granola returns only once. Redirect the output to a protected file. Dry runs and confirmation prompts replace the path, query, and fragment of callback URLs with /[redacted].",
    },
    output: "Resource envelope. data is the webhook endpoint object, including signing_secret; meta is empty.",
    exceptions: [
      {
        rule: "CLI-CFG-4",
        reason: "Prints signing_secret unredacted. Granola returns it once, and it cannot be retrieved later.",
      },
    ],
    method: "POST",
    examples: [
      "granola webhooks create --url https://example.com/granola-webhooks --scope personal --event note.generated --dry-run",
      "granola webhooks create --url https://example.com/granola-webhooks --scope workspace --yes",
    ],
    request: (context) => webhookRequest("/v1/webhook-endpoints", context, true),
  },
  {
    path: ["webhooks", "update"],
    summary: "Update a webhook endpoint.",
    arguments: [WEBHOOK_ID],
    options: [
      { name: "url", placeholder: "URL", type: "string", description: "New HTTPS URL that receives events." },
      {
        name: "scope",
        placeholder: "SCOPE",
        type: "enum",
        choices: WEBHOOK_SCOPES,
        repeatable: true,
        description: "Replace the delivered note scopes. workspace cannot be combined with personal or public.",
      },
      {
        name: "event",
        placeholder: "EVENT",
        type: "enum",
        choices: WEBHOOK_EVENTS,
        repeatable: true,
        description: "Replace the delivered event types.",
      },
      { name: "folder-id", placeholder: "ID", type: "string", repeatable: true, description: "Replace the folder filter." },
      { name: "clear-folder-id", type: "boolean", conflicts: ["folder-id"], description: "Remove the folder filter." },
      {
        name: "enabled",
        placeholder: "BOOLEAN",
        type: "enum",
        choices: ["true", "false"],
        description: "Resume (true) or pause (false) delivery.",
      },
    ],
    effects: {
      kind: "remote-mutation",
      summary:
        "Updates the supplied fields of the webhook endpoint. Omitted fields keep their values. Needs at least one field to change.",
    },
    output: "Resource envelope. data is the updated webhook endpoint object; meta is empty.",
    method: "PATCH",
    examples: ["granola webhooks update whe_01HXYZ --enabled false --dry-run", "granola webhooks update whe_01HXYZ --event note.edited --yes"],
    request: (context) => webhookRequest(`/v1/webhook-endpoints/${encodedId(context)}`, context, false),
  },
  {
    path: ["webhooks", "delete"],
    summary: "Delete a webhook endpoint.",
    arguments: [WEBHOOK_ID],
    options: [],
    effects: {
      kind: "remote-mutation",
      summary: "Permanently deletes the webhook endpoint. Granola documents no way to restore a deleted endpoint.",
    },
    output: "Resource envelope. data is the provider response, or null for an empty body; meta is empty.",
    method: "DELETE",
    examples: ["granola webhooks delete whe_01HXYZ --dry-run", "granola webhooks delete whe_01HXYZ --yes"],
    request: (context) => ({
      path: `/v1/webhook-endpoints/${encodedId(context)}`,
      effect: `Permanently deletes webhook endpoint ${context.args[0]}.`,
    }),
  },
];

function encodedId(context: Context): string {
  return encodeURIComponent(context.args[0] ?? "");
}

function optionQuery(
  context: Context,
  option: string,
  apiName: string,
  validate: (value: string) => string = (value) => value,
): [string, string][] {
  const value = context.options.string(option);
  return value === undefined ? [] : [[apiName, validate(value)]];
}

function validateAction(value: string): string {
  if (/^[a-z][a-z0-9_.-]*$/.test(value)) return value;
  throw invalidValue(
    "--action",
    "start with a lowercase letter and contain only lowercase letters, numbers, dots, hyphens, and underscores",
    value,
    "Use --action workspace.",
    "^[a-z][a-z0-9_.-]*$",
  );
}

function webhookRequest(path: string, context: Context, creating: boolean): RequestSpec {
  const { options } = context;
  const body: Record<string, unknown> = {};
  const url = options.string("url");
  if (url !== undefined) body.url = validateWebhookUrl(url);
  const scopes = options.strings("scope");
  if (scopes.length > 0) body.scopes = validateScopes(scopes);
  const events = options.strings("event");
  if (events.length > 0) body.events = events;
  const folderIds = options.strings("folder-id");
  if (folderIds.length > 0) body.folder_ids = folderIds.map((id) => validateId("--folder-id", id));
  if (options.flag("clear-folder-id")) body.folder_ids = [];
  const enabled = options.string("enabled");
  if (enabled !== undefined) body.enabled = enabled === "true";
  if (Object.keys(body).length === 0) {
    throw missingFields(context.spec.path.join(" "), ["url", "scope", "event", "folder-id", "clear-folder-id", "enabled"], true);
  }
  const redactedUrl = typeof body.url === "string" ? redactWebhookUrl(body.url) : undefined;
  return {
    path,
    body,
    previewBody: redactedUrl === undefined ? body : { ...body, url: redactedUrl },
    ...(typeof body.url === "string" ? { secretValues: webhookSecrets(body.url) } : {}),
    effect: creating
      ? `Creates a webhook endpoint that delivers to ${redactedUrl}.`
      : `Updates webhook endpoint ${context.args[0]}: ${Object.keys(body).join(", ")}.`,
  };
}

function validateScopes(scopes: string[]): string[] {
  if (!scopes.includes("workspace") || scopes.length === 1) return scopes;
  throw invalidValue(
    "--scope",
    "be workspace alone, or personal and public",
    scopes.join(", "),
    "Use --scope workspace alone, or use --scope personal and --scope public.",
  );
}

function validateWebhookUrl(value: string): string {
  const url = parseUrl(value);
  if (url?.protocol === "https:" && !url.username && !url.password) return url.toString();
  throw invalidValue(
    "--url",
    "be an absolute https URL without credentials",
    redactCredentials(value),
    "Use --url https://example.com/granola-webhooks.",
  );
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** The callback URL and its path, query, and fragment: previews hide them, so errors must not echo them either. */
function webhookSecrets(value: string): string[] {
  const url = new URL(value);
  const hidden = `${url.pathname}${url.search}${url.hash}`;
  return hidden === "/" ? [value] : [value, hidden];
}

function redactWebhookUrl(value: string): string {
  const url = new URL(value);
  return url.pathname === "/" && !url.search && !url.hash ? url.origin : `${url.origin}/[redacted]`;
}
