# granola-cli

An agent-friendly command-line interface for the [Granola API](https://docs.granola.ai/introduction).

This project owns the `granola` binary. It is not an official Granola CLI. It covers the public API documented by Granola for notes, transcripts, folders, audit events, and webhook endpoints.

## Install

Install from npm with Node 22 or newer, or with Bun:

```bash
npm install -g @zakiaziz/granola-cli
bun add -g @zakiaziz/granola-cli
```

To work on the CLI, build and link a checkout with `bun install`, `bun run build`, and `bun link`.

## Set up authentication

Create a personal API key in the Granola desktop app under **Settings > Connectors > API keys**. Workspace admins can also create workspace API keys on Business and Enterprise plans.

```bash
granola setup work --api-key "$GRANOLA_API_KEY"
granola auth verify
```

To create a profile from environment variables:

```bash
export GRANOLA_API_KEY="grn_..."
granola setup work --from-env
```

Profiles live under `$XDG_CONFIG_HOME/granola` when `XDG_CONFIG_HOME` is set to an absolute path. Otherwise, they live under `~/.config/granola`. Profile and configuration files use mode `0600`; their directories use mode `0700`.

The CLI resolves API keys in this order:

1. `--api-key`
2. `GRANOLA_API_KEY`
3. The profile selected by `--profile`
4. The active profile

The API root defaults to `https://public-api.granola.ai`. `--base-url`, `GRANOLA_BASE_URL`, a profile value, or global configuration can override it. The override supports local API testing and compatible proxies.

`granola auth verify` requests one note summary from `/v1/notes`. A successful result proves that Granola accepts the bearer token and that the key can access the notes endpoint. Granola does not provide a dedicated identity endpoint, so this command cannot return an account identity.

## Command conventions

Successful responses use compact JSON on stdout by default. Errors use structured JSON on stderr and a nonzero exit code. The CLI does not add colors, progress messages, or explanatory text to command output, which keeps stdout safe for agents and JSON processors.

```bash
granola notes list --created-after 2026-08-01 | jq '.data[] | {id, title}'
```

Unknown options, invalid identifiers, unsupported enum values, out-of-range page sizes, and command-specific option mismatches fail before the CLI sends a request.

### Pagination and output size

Paginated commands request one page by default. Granola currently allows up to 30 notes, folders, or audit events per page and up to 100 transcript items per page.

Use `--all` to follow every cursor and combine the resource array:

```bash
granola notes list --all
```

If a result may be large, combine `--all` with `--max-items`. The CLI adjusts page sizes so it stops on an API cursor boundary. When more results remain, `meta.has_more` is true and `meta.next_cursor` contains the continuation cursor.

```bash
granola notes list --all --max-items 100 > notes.json
granola notes list --cursor "$(jq -r '.meta.next_cursor' notes.json)" --page-size 30
```

`--all` without `--max-items` intentionally has no local limit. Use it only when you want the complete accessible result set.

### Output formats

Use `--format json`, `--format human`, or `--format pretty`. JSON is the default. First-class collections place the provider array in `data` and pagination plus other provider metadata in `meta`; fields inside each provider resource remain unchanged. Pretty uses indented, syntax-highlighted JSON. Human uses tables for collections and labeled fields for individual resources.

```bash
granola notes get not_1d3tmYTlCICgjy --format pretty
granola notes transcript get not_1d3tmYTlCICgjy --all --format human
granola folders list --all --format pretty
```

Use JSON when another program or agent consumes the output. Human output is a presentation format and may omit fields that remain available in JSON.

## Configuration commands

| Command | Description |
| --- | --- |
| `granola setup [profile] [options]` | Create and activate a profile. |
| `granola profiles list` | List profile names and the active profile. |
| `granola profiles get <name>` | Show a profile with its API key redacted. |
| `granola profiles create <name> [options]` | Create a profile. |
| `granola profiles update <name> [options]` | Update a profile. |
| `granola profiles delete <name>` | Delete a profile. |
| `granola profiles use <name>` | Activate a profile. |
| `granola config path` | Show configuration paths. |
| `granola config list` | Show global configuration. |
| `granola config get <key>` | Read `activeProfile` or `baseUrl`. |
| `granola config set <key> <value>` | Set `activeProfile` or `baseUrl`. |
| `granola config unset <key>` | Remove `activeProfile` or `baseUrl`. |
| `granola auth verify` | Verify the API key against the notes endpoint. |

Profile create and update accept `--api-key` and `--base-url`. Setup also accepts `--from-env`.

## Notes

| Command | Options | Description |
| --- | --- | --- |
| `granola notes list` | `--created-before`, `--created-after`, `--updated-after`, `--folder-id`, `--cursor`, `--page-size`, `--all`, `--max-items` | List accessible meeting notes. |
| `granola notes get <noteId>` | `--include transcript` | Get one note, including its summary, attendees, calendar event, and folder membership. |
| `granola notes transcript get <noteId>` | `--cursor`, `--page-size`, `--all`, `--max-items` | Get a transcript in pages. |

Date filters accept `YYYY-MM-DD` or an ISO 8601 Coordinated Universal Time (UTC) timestamp such as `2026-08-27T09:30:00Z`.

`notes get --include transcript` asks Granola to include the transcript inline. If Granola returns `413 TRANSCRIPT_TOO_LARGE`, use `notes transcript get <noteId> --all` to retrieve the complete transcript through the paginated endpoint.

## Folders and audit events

| Command | Options | Description |
| --- | --- | --- |
| `granola folders list` | `--cursor`, `--page-size`, `--all`, `--max-items` | List accessible folders and their parent folder IDs. |
| `granola audit-events list` | `--action`, `--occurred-before`, `--occurred-after`, `--cursor`, `--page-size`, `--all`, `--max-items` | List workspace audit events within Granola's retention window. |

The `--folder-id` notes filter includes notes in the selected folder and its child folders. Use `folders list` to discover folder IDs.

Audit action values form an open set. `--action workspace` matches `workspace` and actions prefixed with `workspace.`, such as `workspace.member_added`.

## Webhook endpoints

| Command | Options | Description |
| --- | --- | --- |
| `granola webhooks list` | None | List webhook endpoints. |
| `granola webhooks create` | `--url`, `--scope`, `--event`, `--folder-id` | Register an HTTPS webhook endpoint. |
| `granola webhooks update <webhookId>` | `--url`, `--scope`, `--event`, `--folder-id`, `--enabled` | Replace selected webhook settings, or pause and resume delivery. |
| `granola webhooks delete <webhookId>` | None | Delete a webhook endpoint. |

Webhook create, update, and delete commands change Granola state. They require `--yes`. Use `--dry-run` to print a redacted request without sending it. Dry runs reduce callback URLs with a path, query, or fragment to their origin because those components can contain credentials.

```bash
granola webhooks create \
  --url https://example.com/granola-webhooks \
  --scope personal --scope public \
  --event note.generated --event note.edited \
  --dry-run
```

Create the endpoint after inspecting the request:

```bash
granola webhooks create \
  --url https://example.com/granola-webhooks \
  --scope personal --scope public \
  --event note.generated --event note.edited \
  --yes > webhook.json
chmod 600 webhook.json
```

Granola returns `signing_secret` only in the successful create response. The CLI includes it in stdout because omitting it would make signature verification impossible. Redirect that response to a protected file or a secret manager, and do not record it in logs.

Supported events are `note.access_granted`, `note.edited`, and `note.generated`. Supported personal API key scopes are `personal` and `public`. Workspace API keys use the single `workspace` scope. Use `--clear-folder-ids` on update to remove an existing folder filter.

## Global options

| Option | Purpose |
| --- | --- |
| `--profile <name>` | Select a saved profile. |
| `--api-key <key>` | Override the Granola API key. |
| `--base-url <url>` | Override the API root. |
| `--timeout <duration>` | Set the per-request timeout. Default: `30s`. |
| `--color <auto\|always\|never>` | Control pretty and human color. |
| `--quiet`, `-q` | Suppress notices. |
| `--verbose`, `-v` | Print redacted diagnostics to stderr. |
| `--no-input` | Disable prompts. |
| `--format <json\|pretty\|human>` | Select the output format. Default: `json`. |
| `--all` | Follow every page for supported commands. |
| `--max-items <number>` | Stop `--all` after this many items and preserve the next cursor. |
| `--dry-run` | Print a redacted webhook request without sending it. |
| `--yes`, `-y` | Confirm a webhook mutation. |
| `--help`, `-h` | Show help. |
| `--version` | Show the version. |

## Development

Use Bun for every local development command:

```bash
bun install
bun run check
bun test
bun run build
bun pm pack --dry-run
```

The test command enforces 100% line and function coverage for loaded source modules. The TypeScript source imports only Node.js standard-library modules. Continuous integration builds and executes the CLI with Bun.

## API references

- [Granola API introduction](https://docs.granola.ai/introduction)
- [List notes](https://docs.granola.ai/api-reference/list-notes)
- [Get note](https://docs.granola.ai/api-reference/get-note)
- [Get transcript](https://docs.granola.ai/api-reference/get-transcript)
- [List folders](https://docs.granola.ai/api-reference/list-folders)
- [Audit events](https://docs.granola.ai/audit-events)
- [Webhooks](https://docs.granola.ai/webhooks)
- [Granola API changelog](https://docs.granola.ai/api-reference/changelog)

## Shell completion

Generate completion from the command registry for your shell:

```bash
granola completions bash
granola completions zsh
granola completions fish
```

Completion includes commands, supported options, fixed option values, and saved profile names. See [the command specification](docs/command-spec.md) for the complete grammar.

### Filter boundaries and ordering

The CLI accepts `YYYY-MM-DD` date-only values and ISO 8601 UTC timestamps with a trailing `Z`; offsets without `Z` are rejected. It passes accepted values to Granola unchanged. Granola public API documentation does not define a timezone for date-only values or whether before and after boundaries are inclusive, so callers must not rely on equality-boundary behavior. Pagination preserves the provider order and cursor sequence. The CLI does not apply local sorting.

### Dry runs

Webhook dry runs validate identifiers, option combinations, URLs, scopes, and events locally, then print a redacted request. They do not contact Granola and do not guarantee that authentication, authorization, or provider-side validation will succeed.
