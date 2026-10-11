import { CliError } from "./errors.js";
export interface CommandSpec {
  readonly path: readonly string[];
  readonly usage: string;
  readonly description: string;
  readonly options: readonly string[];
}
const presentationOptions = ["--format", "--color", "--quiet", "--verbose", "--no-input", "--help"];
const apiOptions = ["--profile", "--api-key", "--base-url", "--timeout"];
export const commandSpecs: readonly CommandSpec[] = [
  { path: ["setup"], usage: "setup [profile]", description: "Create and activate a profile.", options: ["--api-key", "--base-url", "--from-env"] },
  { path: ["profiles", "list"], usage: "profiles list", description: "List saved profiles.", options: [] },
  { path: ["profiles", "get"], usage: "profiles get <name>", description: "Show a redacted profile.", options: [] },
  { path: ["profiles", "create"], usage: "profiles create <name>", description: "Create a profile.", options: ["--api-key", "--base-url"] },
  { path: ["profiles", "update"], usage: "profiles update <name>", description: "Update a profile.", options: ["--api-key", "--base-url"] },
  { path: ["profiles", "delete"], usage: "profiles delete <name>", description: "Delete a profile.", options: [] },
  { path: ["profiles", "use"], usage: "profiles use <name>", description: "Select the active profile.", options: [] },
  { path: ["config", "path"], usage: "config path", description: "Print configuration paths.", options: [] },
  { path: ["config", "list"], usage: "config list", description: "List configuration.", options: [] },
  { path: ["config", "get"], usage: "config get <key>", description: "Get configuration.", options: [] },
  { path: ["config", "set"], usage: "config set <key> <value>", description: "Set configuration.", options: [] },
  { path: ["config", "unset"], usage: "config unset <key>", description: "Unset configuration.", options: [] },
  { path: ["auth", "verify"], usage: "auth verify", description: "Verify API authentication.", options: [] },
  { path: ["notes", "list"], usage: "notes list", description: "List notes.", options: ["--created-before", "--created-after", "--updated-after", "--folder-id", "--cursor", "--page-size", "--all", "--max-items"] },
  { path: ["notes", "get"], usage: "notes get <note-id>", description: "Get a note.", options: ["--include"] },
  { path: ["notes", "transcript", "get"], usage: "notes transcript get <note-id>", description: "Get a transcript.", options: ["--cursor", "--page-size", "--all", "--max-items"] },
  { path: ["folders", "list"], usage: "folders list", description: "List folders.", options: ["--cursor", "--page-size", "--all", "--max-items"] },
  { path: ["audit-events", "list"], usage: "audit-events list", description: "List audit events.", options: ["--action", "--occurred-before", "--occurred-after", "--cursor", "--page-size", "--all", "--max-items"] },
  { path: ["webhooks", "list"], usage: "webhooks list", description: "List webhooks.", options: [] },
  { path: ["webhooks", "create"], usage: "webhooks create", description: "Create a webhook.", options: ["--url", "--scope", "--event", "--folder-id", "--dry-run", "--yes"] },
  { path: ["webhooks", "update"], usage: "webhooks update <webhook-id>", description: "Update a webhook.", options: ["--url", "--scope", "--event", "--folder-id", "--clear-folder-ids", "--enabled", "--dry-run", "--yes"] },
  { path: ["webhooks", "delete"], usage: "webhooks delete <webhook-id>", description: "Delete a webhook.", options: ["--dry-run", "--yes"] },
  { path: ["completions"], usage: "completions <bash|zsh|fish>", description: "Print shell completion.", options: [] },
];
export function scopedHelp(command: readonly string[]): string | undefined {
  const children = commandSpecs.filter(candidate => command.length > 0 && command.every((part, index) => candidate.path[index] === part));
  if (children.length > 1 && !children.some(candidate => candidate.path.length === command.length)) {
    return `${command.join(" ")} commands:\n\n${children.map(candidate => `  granola ${candidate.usage}  ${candidate.description}`).join("\n")}`;
  }
  const spec = commandSpecs.filter(candidate => candidate.path.every((part, index) => command[index] === part)).sort((left, right) => right.path.length - left.path.length)[0];
  if (!spec)
    return undefined;
  const mutation = spec.path[0] === "webhooks" && ["create", "update", "delete"].includes(spec.path[1] ?? "");
  const paginated = spec.options.includes("--all");
  const isApi = !["setup", "profiles", "config", "completions"].includes(spec.path[0] ?? "");
  const optionLines = [...spec.options, ...(isApi ? apiOptions : []), ...presentationOptions]
    .map(option => `  ${option}`)
    .join("\n");
  return `${spec.description}\n\nUsage:\n  granola ${spec.usage} [options]\n\nOptions:\n${optionLines}\n\nTypes and defaults:\n  IDs and cursors are opaque strings. --timeout defaults to 30s. --format defaults to json. --color defaults to auto.\n  Allowed formats: json, pretty, human. Allowed colors: auto, always, never.\n\nExample:\n  granola ${spec.usage.replace(/<[^>]+>/g, "EXAMPLE_ID")} --format pretty\n\nOutput:\n  JSON data/meta envelope by default; pretty and human presentations are available.${paginated ? "\n  Fetches one page by default; --all follows cursors and --max-items bounds traversal." : ""}\n\nSide effects:\n  ${mutation ? "Changes remote Granola state; requires --yes or interactive confirmation. --dry-run validates locally and sends no request." : "No remote mutation."}\n\nFailures:\n  Invalid input exits 2; authentication exits 3; not found exits 5; conflicts exit 6; transient failures exit 7.${mutation ? " Missing or declined confirmation exits 9." : ""}`;
}
export function completion(shell: string, profiles: readonly string[]): string {
 if (!["bash", "zsh", "fish"].includes(shell)) {
  throw new CliError("Usage: granola completions <bash|zsh|fish>");
 }
 const words = [...new Set(
  commandSpecs.flatMap(spec => [spec.path.join(" "), ...spec.options]),
 )].join(" ");
 const globals = [...apiOptions, ...presentationOptions, "--version", "-h", "-q", "-v", "-y"];
 const wordsWithGlobals = `${words} ${globals.join(" ")}`;
 const profileWords = profiles.join(" ");
 const values = "json pretty human auto always never personal public workspace note.access_granted note.edited note.generated transcript true false bash zsh fish";
 if (shell === "fish") {
  return `complete -c granola -f -a \'${wordsWithGlobals} ${profileWords} ${values}\'`;
 }
 if (shell === "zsh") {
  return `#compdef granola\n_arguments \'*: :(${wordsWithGlobals} ${profileWords} ${values})\'`;
 }
 return `complete -W \'${wordsWithGlobals} ${profileWords} ${values}\' granola`;
}
