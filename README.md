# granola-cli

Command-line interface for the Granola API. It reads meeting notes, transcripts, folders, and audit events, manages webhook endpoints, and sends raw API requests. It is not an official Granola product.

## Install

Requires Node.js 22 or newer.

```bash
npm install -g @zakiaziz/granola-cli
bun add -g @zakiaziz/granola-cli
cd granola-cli && bun run build && bun link
```

## Quick start

```bash
granola setup
# List notes created since August 1 as a table.
granola notes list --created-after 2026-08-01
# Get one note with its transcript inline.
granola notes get not_1d3tmYTlCICgjy --include transcript
# Preview a webhook endpoint without creating it.
granola webhooks create --url https://example.com/granola-webhooks --scope personal --dry-run
```

## Commands

### audit-events

| Command | Description | Options |
| --- | --- | --- |
| granola audit-events list | List workspace audit events. | --action ACTION, --occurred-before DATE, --occurred-after DATE, --page-size N, --cursor TOKEN, --all, --max-items N |

### folders

| Command | Description | Options |
| --- | --- | --- |
| granola folders list | List folders. | --page-size N, --cursor TOKEN, --all, --max-items N |

### notes

| Command | Description | Options |
| --- | --- | --- |
| granola notes list | List meeting notes. | --created-before DATE, --created-after DATE, --updated-after DATE, --folder-id ID, --page-size N, --cursor TOKEN, --all, --max-items N |
| granola notes get NOTE_ID | Get one meeting note. | --include RESOURCE |
| granola notes transcript get NOTE_ID | Get the transcript of one note. | --page-size N, --cursor TOKEN, --all, --max-items N |

### webhooks

| Command | Description | Options |
| --- | --- | --- |
| granola webhooks list | List webhook endpoints. | None |
| granola webhooks create | Create a webhook endpoint. | --url URL, --scope SCOPE, --event EVENT, --folder-id ID, --yes, --dry-run |
| granola webhooks update WEBHOOK_ID | Update a webhook endpoint. | --url URL, --scope SCOPE, --event EVENT, --folder-id ID, --clear-folder-id, --enabled BOOLEAN, --yes, --dry-run |
| granola webhooks delete WEBHOOK_ID | Delete a webhook endpoint. | --yes, --dry-run |

### setup

| Command | Description | Options |
| --- | --- | --- |
| granola setup [NAME] | Create and activate a profile. | --api-key-file PATH, --base-url URL |

### profiles

| Command | Description | Options |
| --- | --- | --- |
| granola profiles list | List saved profiles. | None |
| granola profiles get NAME | Get one saved profile with secrets redacted. | None |
| granola profiles create NAME | Create a profile without activating it. | --api-key-file PATH, --base-url URL |
| granola profiles update NAME | Update fields of a profile. | --api-key-file PATH, --base-url URL, --clear-base-url |
| granola profiles delete NAME | Delete a profile. | None |
| granola profiles use NAME | Make a profile the active profile. | None |

### config

| Command | Description | Options |
| --- | --- | --- |
| granola config list | List every configuration key. | None |
| granola config get KEY | Get one configuration value. | None |
| granola config path | Get the configuration paths. | None |

### auth

| Command | Description | Options |
| --- | --- | --- |
| granola auth verify | Verify the API key. | None |

### api

| Command | Description | Options |
| --- | --- | --- |
| granola api request METHOD PATH | Send a raw API request. | --query KEY=VALUE, --file PATH, --yes, --dry-run |

### completions

| Command | Description | Options |
| --- | --- | --- |
| granola completions SHELL | Print a shell completion script. | None |

## Global options

| Option | Description |
| --- | --- |
| -h, --help | Show help. Uses no credentials or network. |
| --version | Print the executable name and version. |
| --profile NAME | Select a saved profile. |
| --format FORMAT | Output format. Allowed: json, pretty, human. Default: human. |
| --color WHEN | Color for pretty and human output. Allowed: auto, always, never. Default: auto. |
| -q, --quiet | Suppress progress and notices. Results and errors still print. |
| -v, --verbose | Print redacted diagnostics to stderr. |
| --no-input | Never prompt. Fail when input is missing. |
| --timeout DURATION | Per-request timeout in ms, s, or m, from 1ms to 10m. Default: 30s. |

Network commands (the resource commands, `auth verify`, and `api request`) accept every option except `--version`. Local commands (`setup`, `profiles`, and `config`) accept `--help`, `--format`, `--color`, `--quiet`, `--verbose`, and `--no-input`. `completions` accepts only `--help`. With no command, only `--help`, `--version`, `--verbose`, and `--quiet` apply, and `--version` with a command word fails.

## Authentication

Create a personal API key in the Granola desktop app under **Settings > Connectors > API keys**. Workspace admins can also create workspace API keys on Business and Enterprise plans.

```bash
granola setup work --api-key-file ./granola-api-key.txt
granola auth verify
```

`setup [NAME]` creates a profile (default name: `default`) and makes it the active profile. It fails when the profile exists. If activation fails after the profile is written, the profile stays saved and `setup` exits 8 with `PARTIAL_FAILURE`. In a terminal without `--no-input`, `setup` prompts for a missing API key with hidden input. Secrets are never command-line values: pass `--api-key-file PATH` (`-` reads stdin) or enter the key at the prompt.

Credentials and endpoint settings come only from a profile. No environment variable supplies them or selects a profile, so a scheduled job passes `--profile NAME` explicitly. Profile selection is `--profile NAME`, otherwise `activeProfile` in `config.json`. A selected or active profile that does not exist, and no profile at all, fail with `CONFIGURATION_ERROR` and no fallback. The hint points to `granola setup NAME` or `granola profiles use NAME`.

The CLI reads three environment variables, and none supplies credentials, endpoints, or a profile:

| Variable | Purpose |
| --- | --- |
| `XDG_CONFIG_HOME` | Configuration root when it is an absolute path. Otherwise `~/.config`. |
| `NO_COLOR` | Disables color with `--color auto` when set and nonempty. |
| `CI` | Disables prompts when nonempty and not `0` or `false`. |

Stored in the profile:

- Base URL: `baseUrl` in the profile, then `https://public-api.granola.ai`.

`granola auth verify` sends `GET /v1/notes?page_size=1`. Success proves that Granola accepted the API key for that read. Granola has no identity endpoint, so the command returns no account identity and does not prove complete permission coverage.

## Output and errors

The default output format is `human`: tables for collections and labeled fields for one resource, whatever the terminal. Nested objects and arrays inside one resource print as indented fields and lists, and a table cell shows a short summary such as a name or `N items`, never raw JSON. A dry run prints `dry_run` and `validation`, then each request on its own lines. `--format json` prints one compact, uncolored line on stdout with the envelope `{"data":...,"meta":{...}}`, and scripts and agents pass it explicitly. `--format pretty` prints the same document indented, with syntax highlighting when color applies. With `--format pretty` or the default `human` format and stderr on a terminal, a command that sends a request first prints one gray line, `Profile: NAME`, to stderr. `--quiet` suppresses it, and `--format json` never prints it. Errors go to stderr in the selected format, so the default error is the `human` text. Help, `--version`, and `completions` print plain text. The bare command and a command group with no action print the same help as `--help` on stdout, exit 0; an unknown action fails with exit 2.

`data` is an object for one resource, an array for a collection, or `null`, and keeps Granola's field names. `meta` is always present.

| `meta` key | When |
| --- | --- |
| `profile` | Every command that sends a request. The name of the profile that served it. |
| `next_cursor` | Paginated collection reads. A string, or `null` when no page remains. |
| `has_more` | Paginated collection reads. |
| `provider` | Other collection fields that Granola returns. |
| `dry_run`, `validation` | Dry-run previews. `validation` is `local`. |

With `--format json`, errors print one compact document on stderr, for example `{"error":{"code":"RATE_LIMITED","message":"...","hint":"...","retryable":true,"provider":{"status":429}}}`. Optional keys are `hint`, `outcome` (`unknown` when a mutation may have applied), `provider` (`status`, `code`, `request_id`, `retry_after_seconds`), `details`, and `partial`. The default `human` format prints `Error [CODE]: message` and `Hint: ...`.

| Exit | Error codes |
| --- | --- |
| 0 | Success, including empty collections. |
| 1 | `UNEXPECTED_ERROR`, `PROVIDER_ERROR`, `INVALID_RESPONSE`, `UNSUPPORTED_RESPONSE` |
| 2 | `INVALID_ARGUMENT`, `INVALID_REQUEST` |
| 3 | `CONFIGURATION_ERROR`, `AUTHENTICATION_REQUIRED`, `AUTHENTICATION_FAILED` |
| 4 | `PERMISSION_DENIED` |
| 5 | `NOT_FOUND` |
| 6 | `CONFLICT` |
| 7 | `RATE_LIMITED`, `TRANSIENT_FAILURE` |
| 8 | `PARTIAL_FAILURE` |
| 9 | `CONFIRMATION_REQUIRED`, `CONFIRMATION_DECLINED` |
| 130 | `INTERRUPTED` |

IDs are opaque strings. Options accept `--name value` and `--name=value`, and `--` ends options. Dates accept `YYYY-MM-DD` (read as 00:00 UTC) and `YYYY-MM-DDTHH:MM:SS[.fff](Z|+HH:MM)`; the CLI sends the UTC instant, and Granola does not document whether `before` and `after` boundaries are inclusive. Unknown commands, options, extra arguments, invalid values, and conflicting options fail with exit code 2 before any request.

Mutations (`webhooks create`, `webhooks update`, `webhooks delete`, and `api request` with `POST`, `PUT`, `PATCH`, or `DELETE`) need confirmation. The CLI validates arguments first, then resolves credentials (exit 3 when missing), then asks for confirmation. In a terminal, it shows the profile, operation, request, and effect, then prompts. `--yes` confirms without a prompt. With `--no-input`, a non-terminal stdin or stderr, or CI mode, a missing confirmation exits 9. Ctrl-C or end of input at a prompt exits 130 with `INTERRUPTED`. `--dry-run` prints a redacted preview of the request, with headers in the order `Authorization`, `Accept`, `Content-Type`, and sends nothing. It needs a profile but no stored credentials. Preview success does not guarantee that the request succeeds.

Dry runs and confirmation prompts replace the path, query, and fragment of webhook callback URLs with `/[redacted]`, because those parts can carry credentials. Granola returns `signing_secret` only in the successful `webhooks create` response, and the CLI prints it on purpose because signature verification needs it. Redirect that output to a protected file, for example `(umask 077; granola webhooks create ... --yes --format json > webhook.json)`.

Reads make up to 3 attempts on HTTP 429, 500, 502, 503, 504, network errors, and timeouts, waiting 250 ms, then 500 ms, or the `Retry-After` value up to 10 seconds. A `Retry-After` above 10 seconds is not waited on: the command fails with `RATE_LIMITED` and `provider.retry_after_seconds`. Mutations make one attempt. `--timeout` applies to each attempt. `--verbose` writes redacted request, response, and retry diagnostics to stderr.

## Pagination

Paginated commands fetch one page by default. `--page-size` is limited to 30 for notes, folders, and audit events, and to 100 for transcripts. The defaults are 10 for notes and folders, 50 for transcripts, and 30 for audit events. Folders come back in alphabetical order by name. For other collections the CLI keeps Granola's order and never sorts.

`--all` follows every cursor. `--max-items N` (with `--all`) shrinks the last request so the read stops on a page boundary, and `meta.next_cursor` resumes it. `--cursor TOKEN` resumes from a previous `meta.next_cursor`, with or without `--all`.

```bash
granola notes list --all --max-items 100 --format json > notes.json
granola notes list --all --cursor "$(jq -r '.meta.next_cursor' notes.json)" --format json
```

A repeated cursor or an oversized page on the first page fails with `INVALID_RESPONSE` and exit 1. A failure on a later page exits 8 with `PARTIAL_FAILURE`. The items read so far are in `error.partial.data`, `error.partial.next_cursor` points at the first unread item, and `error.details.cause` names the underlying error code, such as `INVALID_RESPONSE`. `webhooks list` is unpaginated: Granola returns the full list in one response and meta has only profile.

## Raw API access

```bash
granola api request GET /v1/notes --query page_size=5
granola api request PATCH /v1/webhook-endpoints/whe_01HXYZ --file ./patch.json --dry-run
```

Methods: `GET`, `HEAD`, `OPTIONS`, `POST`, `PUT`, `PATCH`, `DELETE`. `PATH` starts with a single `/` and has no scheme, host, query string, fragment, whitespace, or `.` and `..` segments. Add query parameters with the repeatable `--query KEY=VALUE`. `--file PATH` sends a JSON body as `application/json` (`-` reads stdin). `--file`, `--yes`, and `--dry-run` are rejected on `GET`, `HEAD`, and `OPTIONS`. The CLI sends the selected profile's bearer token only to the configured API origin. JSON responses print as parsed, other text prints as a JSON string, an empty body prints `null`, and binary responses fail with `UNSUPPORTED_RESPONSE`. Non-2xx responses use the same error mapping as other commands.

## Configuration

Files live in `$XDG_CONFIG_HOME/granola` when `XDG_CONFIG_HOME` is an absolute path, and in `~/.config/granola` otherwise.

```text
granola/
  config.json            {"activeProfile": "work"}
  profiles/NAME.json     {"apiKey": "...", "baseUrl": "https://..."}
```

Keys are camelCase. Files use mode `0600`, directories use mode `0700`, and writes are atomic: the CLI creates a temporary file exclusively with mode `0600` in the same directory, then renames it. Reads reject unknown keys and non-object JSON with `CONFIGURATION_ERROR`. Profile names match `^[A-Za-z0-9._-]+$` and are not `.` or `..`. `config.json` holds one key, `activeProfile` (read-only through `config`; change it with `profiles use`). Credentials and endpoint settings live only in profile files, and a `config.json` with any other key fails with `CONFIGURATION_ERROR`. Profile fields: `apiKey` and `baseUrl`. Secrets are redacted in previews, diagnostics, `profiles get`, and `config list`.

A base URL, from `--base-url` or a stored file, must be an `https` URL (`http` only for `localhost`, `127.0.0.1`, or `::1`) with no credentials, query string, fragment, or path. Values are stored unchanged, and requests go to the URL's origin.

Completion scripts come from `granola completions bash|zsh|fish` and read only the command registry and local profile names. They complete commands, options, enum values (after `--OPT ` and `--OPT=`), `METHOD`, `SHELL`, and profile names (after `--profile` and for the `NAME` argument of `profiles get|update|delete|use`). They offer nothing after `--` or after an option that takes a free-form value.

## Exceptions

| Rule | Decision | Reason |
| --- | --- | --- |
| `CLI-CFG-4` | `webhooks create` prints `signing_secret` unredacted. | Granola returns the signing secret once, so it cannot be retrieved later. Dry runs and confirmation prompts stay redacted. |

## Development

```bash
bun run build
bun run check
bun link
```

`src/core/` is vendored from cli-core and is never edited here. Change cli-core and run its sync script instead. `docs/cli-conventions.md` restates the command-line contract this tool follows.

## API references

- [Granola API introduction](https://docs.granola.ai/introduction)
- [List notes](https://docs.granola.ai/api-reference/list-notes)
- [Get note](https://docs.granola.ai/api-reference/get-note)
- [Get transcript](https://docs.granola.ai/api-reference/get-transcript)
- [List folders](https://docs.granola.ai/api-reference/list-folders)
- [Audit events](https://docs.granola.ai/audit-events)
- [Webhooks](https://docs.granola.ai/webhooks)
- [Granola API changelog](https://docs.granola.ai/api-reference/changelog)
