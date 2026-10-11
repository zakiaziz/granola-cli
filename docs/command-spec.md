# Command specification

`src/registry.ts` is the runtime source of truth for command discovery, help, and shell completion. [`commands.json`](./commands.json) is the complete reviewable contract generated from that registry and the current validation rules. Rule IDs such as `CLI-RETRY-1` refer to [`cli-conventions.md`](./cli-conventions.md).

The JSON specification contains one entry for every command. Each entry defines:

- Exact usage, positional arguments, option types, allowed values, defaults, and repeatability.
- Pre-request validation and explicit clearing or conflict behavior.
- Authentication and configuration precedence.
- Local read, local write, remote read, or confirmed remote mutation effects.
- JSON output schema and human presentation.
- Pagination limits, continuation, ordering, and `--max-items` behavior.
- Exit-code failures, retry behavior, compatibility mappings, examples, and documented exceptions.

## Shared schemas

First-class individual commands return `ResourceResult`:

```json
{"data":{"id":"opaque-provider-id"},"meta":{}}
```

Collection commands return `CollectionResult`. Provider resource field names remain unchanged inside `data`:

```json
{"data":[{"id":"opaque-provider-id"}],"meta":{"next_cursor":null,"has_more":false}}
```

Errors are written to stderr. JSON and pretty modes use `ErrorResult`:

```json
{"error":{"code":"INVALID_ARGUMENT","message":"Actionable constraint failure.","retryable":false}}
```

Provider failures add `status`, `provider_code`, and `request_id` when available. This CLI has no multi-write first-class command, so a partial-result schema does not apply. Webhook mutations issue one provider request and never claim rollback.

## Input and update behavior

Identifiers and cursors are opaque strings. Unknown options, irrelevant options, duplicate scalar options, extra arguments, invalid values, and conflicting inputs fail before requests.

Webhook update preserves omitted fields. Repeat `--folder-id`, `--scope`, and `--event` for collection values. `--clear-folder-ids` explicitly sends an empty `folder_ids` array and conflicts with `--folder-id`. Empty strings do not imply clearing.

Date filters accept `YYYY-MM-DD` or an ISO 8601 Coordinated Universal Time timestamp with a trailing `Z`. Granola does not document a timezone for date-only values or inclusive/exclusive equality boundaries, so callers must not depend on equality-boundary behavior.

## Authentication and effects

Remote commands resolve authentication from explicit `--api-key`, `GRANOLA_API_KEY`, and the selected profile, in that order. Base URL precedence is `--base-url`, `GRANOLA_BASE_URL`, selected profile, global config, then the documented provider default. A selected missing profile fails rather than falling back.

Webhook create, update, and delete require `--yes` or interactive confirmation. They never prompt with `--no-input`, nonterminal stdin, or Continuous Integration mode. `--dry-run` performs local validation and prints a redacted plan without provider reads or writes.

## Pagination and retries

Paginated commands fetch one page by default. `--all` follows opaque provider cursors, and `--max-items` bounds traversal by reducing the requested page size so no unread item is discarded. Provider ordering is preserved. Maximum page sizes are recorded per command in `commands.json`.

Mutations are never retried automatically. A mutation network or timeout failure reports an unknown outcome and requires remote-state verification before retrying. Safe-read retries are a documented `CLI-RETRY-1` exception until the tool has a bounded backoff and provider `Retry-After` policy.

## Compatibility

The contract version is `0.1.0`. The CLI keeps one canonical spelling and does not provide permanent aliases.
