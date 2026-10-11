# CLI conventions

The command-line contract this tool follows. Read before designing,
implementing, or reviewing commands.

Rules have stable IDs. MUST is required; SHOULD permits a documented exception
with its reason. Cite IDs in findings. Existing code is not precedent.

## Command grammar

~~~text
<tool> <resource> <action> [identifier] [options]
<tool> <resource> <subresource> <action> [identifier] [options]
<tool> <utility-group> <action> [arguments] [options]
~~~

- `CLI-GRAM-1` MUST use noun-first commands, plural resources, explicit actions,
  and lowercase kebab-case. Singleton concepts and utility groups remain
  singular: account, auth, config, api.
- `CLI-GRAM-2` MUST preserve meaningful provider terminology. Notes and
  transcripts need not share a name.
- `CLI-GRAM-3` SHOULD use at most one subresource level, only for a distinct
  concept. Do not mechanically reproduce API URL hierarchies.
- `CLI-GRAM-4` MUST use the action vocabulary below. Implement only supported
  provider capabilities; retain domain actions such as send and publish.
- `CLI-GRAM-5` MUST reserve edit for opening an editor. Flag-driven changes use
  update. Inspection uses get, not show, view, or details.
- `CLI-GRAM-6` SHOULD use one positional identifier for the primary target.
  Scope and secondary IDs use options; dynamic object types use --type.

| Action | Contract |
| --- | --- |
| list | Retrieve a collection, optionally filtered. |
| get | Retrieve one identified resource or singleton. |
| search | Search text or a documented provider expression. |
| create | Create a resource. |
| update | Change supplied fields; preserve omitted fields. |
| replace | Replace using a documented complete-input contract. |
| delete | Delete; document recoverability. |
| archive / restore | Change archival state where supported. |
| send / publish / retry | Perform the named domain operation. |
| export / import | Transfer content through a documented file format. |
| batch-get / batch-create / batch-update | Operate on explicit multiple targets. |

Illustrative shapes, using a generic `tool` executable:

~~~bash
tool notes get NOTE_ID
tool notes transcript get NOTE_ID
tool articles update ARTICLE_ID --title "New title"
tool objects get RECORD_ID --type contacts
~~~

## Arguments and input

- `CLI-IN-1` MUST reject unknown commands, options, extra arguments, invalid
  values, and conflicting inputs before requests. Never execute guessed
  corrections or silently ignore options.
- `CLI-IN-2` MUST accept --name value and --name=value, and honor -- as the end
  of options. IDs are opaque strings. Alternate identifiers require explicit
  selectors such as --id-property email; do not infer their type.
- `CLI-IN-3` MUST interpret content literally. Use --body-file PATH for content
  files and --file PATH for complete structured input. A file path of - means
  stdin. Do not expand @filename in ordinary content.
- `CLI-IN-4` MUST reject complete-file input mixed with field flags unless the
  specification explicitly defines merging. Reject duplicate scalar options;
  declare repeatable options.
- `CLI-IN-5` SHOULD use repeatable collection options, such as --label account
  --label security, instead of comma-delimited input.
- `CLI-IN-6` MUST distinguish omitted, empty, null, and cleared update values.
  Document explicit clearing behavior; do not infer removal from empty strings.
- `CLI-IN-7` MUST document accepted ISO 8601 forms, date-only timezone, and
  inclusive or exclusive filter boundaries.
- `CLI-IN-8` MUST validate structured input. Free-form provider properties
  require explicit input such as --property name=value and documented types.

## Options

- `CLI-OPT-1` MUST use the global names and meanings below. An option is global
  only when applicable throughout the tool.
- `CLI-OPT-2` MUST reserve the listed short flags. New flags SHOULD have only
  long names. --version has no short form.
- `CLI-OPT-3` MUST keep pagination, confirmation, previews, and file input
  command-specific. Shared names do not make options global.
- `CLI-OPT-4` MUST reject irrelevant flags, unsupported formats, and conflicting
  options, including --quiet with --verbose. Never silently fall back.

| Global option | Contract |
| --- | --- |
| --help, -h | Local help; no credentials or network. |
| --version | Executable name and version as text. |
| --profile NAME | Select a saved configuration. |
| --format json\|pretty\|human | Default json: compact and uncolored. Pretty: indented JSON with syntax highlighting. Human: tables or labeled fields. |
| --quiet, -q | Suppress progress and notices, preserving results and errors. |
| --verbose, -v | Redacted diagnostics on stderr. |
| --no-input | Never prompt; fail for missing required input. |
| --color auto\|always\|never | Color for pretty and human formats; default auto. JSON format is always uncolored. |
| --timeout DURATION | Per-request timeout with units, such as 30s; document default. |

| Command-specific option | Contract |
| --- | --- |
| --yes, -y | Supply confirmation. |
| --dry-run | Preview without writes. |
| --all | Traverse all collection read pages. |
| --page-size N | Requested page size within provider limits. |
| --cursor TOKEN | Resume supported collection reads. |
| --max-items N | Bound total traversal. |
| --file PATH | Structured input; - reads stdin. |

Provider options such as --locale retain their meaning and declare their scope.
Additional presentation formats such as markdown require explicit command support.

## Utilities and configuration

- `CLI-CFG-1` MUST use these names for supported capabilities:
  profiles list|get|create|update|delete|use; auth verify;
  config get|set|unset|list|path; completions bash|zsh|fish;
  api request METHOD PATH.
- `CLI-CFG-2` MUST implement setup through the same profile/config operations
  as explicit commands. Setup may create and activate a profile.
- `CLI-CFG-3` MUST document precedence: explicit options, tool-prefixed
  environment variables, selected profile, then documented defaults.
  An explicitly requested missing profile fails without account fallback.
- `CLI-CFG-4` SHOULD accept secrets through environment variables, protected
  files, or hidden prompts instead of command-line values. MUST redact secrets
  in diagnostics, previews, and configuration inspection. Declare intentional
  secret output, such as a newly created webhook signing secret.
- `CLI-CFG-5` MUST keep configuration per tool, honor an absolute
  XDG_CONFIG_HOME with ~/.config as fallback, and protect credential files
  with mode 0600 and their directories with mode 0700 on Unix.
- `CLI-CFG-6` MUST describe what auth verify proves. A successful resource
  request does not prove identity or complete permission coverage.

## Help and completion

- `CLI-HELP-1` MUST provide --help at every command level: purpose, usage,
  types, defaults, allowed values, examples, output, pagination, side effects,
  and relevant failures.
- `CLI-HELP-2` MUST show concise help and exit 0 for no command. Incomplete
  operations fail with exit 2 and focused usage.
- `CLI-HELP-3` MUST derive help and completions from the same command
  definitions. Completion commands print scripts, not edit shell files.
- `CLI-HELP-4` SHOULD support Bash, Zsh, and Fish completion for commands,
  options, static values, and local profiles. MUST NOT request network data
  for completion by default.

## Output

- `CLI-OUT-1` MUST default operational commands to --format json regardless of
  terminal detection: compact JSON on one line, with no indentation, syntax
  highlighting, or extra whitespace outside string values, followed by one
  newline. This is the default for LLMs and scripts. Help, version, and
  completion retain documented text outputs.
- `CLI-OUT-2` MUST send results to stdout and progress, warnings, prompts,
  diagnostics, and errors to stderr. Structured results contain no surrounding
  prose. --format json never contains ANSI escape sequences, even with
  --color always.
- `CLI-OUT-3` MUST emit one JSON document for ordinary successful operations.
  First-class commands use a data/meta envelope. data is an object for one
  resource, an array for collections, or null for no returned resource.
- `CLI-OUT-4` MUST preserve provider field names within data. Paginated meta
  includes next_cursor and has_more where supported. Never claim completeness
  for truncated or provider-capped results.
- `CLI-OUT-5` MUST preserve provider JSON shape for raw api request output.
  Represent non-JSON text as a JSON string and an empty body as null.
  Unsupported binary output fails explicitly.
- `CLI-OUT-6` SHOULD use tables for human collections and labeled fields for
  individual resources. Human output is not a parsing contract.

~~~json
{
  "data": [{"id": "789", "title": "Reset your password"}],
  "meta": {"next_cursor": null, "has_more": false}
}
~~~

- `CLI-OUT-7` MUST support --format pretty for the same JSON document and fields
  as json, indented with two spaces and followed by one newline. Syntax
  highlighting follows --color; formatting never changes values or schemas.
- `CLI-OUT-8` MUST apply color independently to each output stream in pretty
  and human modes. With --color auto, highlight only when that stream is a
  terminal and NO_COLOR is unset or empty. --color never disables color;
  explicit --color always enables it, including when redirected or NO_COLOR
  is set. ANSI-colored pretty output is presentation, not parseable JSON;
  --format json always remains parseable and uncolored.
- `CLI-OUT-9` MUST support --format human as an explicit alternative to JSON
  presentation. Do not switch formats automatically based on terminal detection.

~~~bash
tool notes list                            # Compact, uncolored JSON.
tool notes list --format pretty            # Indented JSON; highlighted in a terminal.
tool notes list --format pretty --color never
tool notes list --format human             # Human-readable table.
~~~

## Errors and exit codes

- `CLI-ERR-1` MUST send structured errors to stderr in json and pretty modes,
  using the selected format and that stream's color policy, and actionable
  text in human mode. Codes are stable; messages identify the failed
  constraint and invalid value when safe. Never echo secrets.
- `CLI-ERR-2` MUST include provider status, code, and request ID when available.
  State retryability without implying that repeating a mutation is safe.
- `CLI-ERR-3` MUST use the exit codes below. Empty collections succeed;
  missing requested individual resources fail.
- `CLI-ERR-4` MUST report completed and failed steps/items on partial operations,
  exit 8, and avoid implying rollback. Specify the partial-result schema.

| Code | Meaning |
| --- | --- |
| 0 | Success, including empty collections. |
| 1 | Unexpected or unclassified failure. |
| 2 | Invalid command, argument, or option. |
| 3 | Missing or invalid configuration or authentication. |
| 4 | Permission denied. |
| 5 | Resource not found. |
| 6 | Conflict or unmet precondition. |
| 7 | Rate limit or transient service/network failure. |
| 8 | Partial completion. |
| 9 | Confirmation required or declined. |
| 130 | Interrupted by user. |

~~~json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "--page-size must be between 1 and 30; received 100.",
    "hint": "Use --page-size 30.",
    "retryable": false
  }
}
~~~

## Mutations and automation

- `CLI-SAFE-1` MUST require confirmation for remote mutations. In an interactive
  terminal, show profile, target, and effects before prompting. --yes supplies
  confirmation, never missing fields, validation bypass, or authorization.
- `CLI-SAFE-2` MUST NOT prompt with --no-input, nonterminal stdin, or CI mode.
  Missing confirmation exits 9. CI mode means CI is nonempty and not 0 or false,
  case-insensitively. Never consume request-content stdin as prompt input.
- `CLI-SAFE-3` MUST NOT alias --force to --yes. A constraint override requires
  a distinct documented meaning and still needs mutation confirmation.
- `CLI-SAFE-4` MUST make dry runs write-free and redact previews. State whether
  previews validate locally or also read remotely. Preview success does not
  guarantee execution success. Dry runs need no confirmation.
- `CLI-SAFE-5` MUST classify first-class operations by effects, not HTTP method.
  POST search is a read. Raw requests conservatively require confirmation for
  methods other than GET, HEAD, and OPTIONS.
- `CLI-SAFE-6` MUST require explicit targets for destructive batches. --all
  belongs to read pagination, never implicit mutation scope.
- `CLI-SAFE-7` MUST document multi-request atomicity. Do not promise rollback
  without implementing it.
- `CLI-SAFE-8` MUST return job ID and status for asynchronous work. If supported,
  --wait has a documented overall timeout distinct from request timeout.

## Pagination, batches, and retries

- `CLI-PAGE-1` MUST fetch one page by default. --all follows continuation;
  --max-items bounds traversal. Document provider limits and ordering.
- `CLI-PAGE-2` MUST preserve continuation without skipping items. When stopping
  mid-page, preserve unread position or stop at a resumable boundary.
  Never return a next-page cursor after discarding unread current-page items.
- `CLI-PAGE-3` MUST report pagination limitations. Do not invent usable cursors
  when the provider cannot support continuation.
- `CLI-BATCH-1` MUST use explicit batch actions and per-item outcomes.
  Partial success is not exit 0.
- `CLI-RETRY-1` SHOULD retry safe reads with bounded backoff and provider retry
  guidance. MUST NOT automatically retry mutations unless duplicate effects
  are prevented. An unknown outcome is not proof of failure.

## Raw API access

- `CLI-API-1` MUST use api request METHOD PATH, repeatable --query key=value,
  and --file PATH for structured bodies. Preserve explicit provider query names.
  Reject unknown flags instead of translating them into API fields.
- `CLI-API-2` MUST document supported methods, authentication, and content
  types. Never silently send selected-profile credentials to another origin.
- `CLI-API-3` MUST separate raw access from first-class input contracts.
  It is an escape hatch, not a second implicit option interpretation.

## Compatibility and implementation

- `CLI-COMPAT-1` MUST version commands, options, defaults, JSON shapes, and exit
  codes as contracts. Publish migration mappings before removing old behavior.
- `CLI-COMPAT-2` MUST keep one canonical spelling. Temporary aliases warn on
  stderr and name their removal release. Do not add permanent get/show/view
  or singular/plural synonyms.
- `CLI-COMPAT-3` MUST explicitly migrate existing -v version behavior before
  assigning -v to verbose. Do not silently reinterpret scripts.
- `CLI-ARCH-1` SHOULD centralize parsing, output, errors, confirmation, and help
  machinery. MUST keep provider authentication and API behavior in focused
  components. Prefer composition over a provider-aware base class.
- `CLI-VERIFY-1` MUST verify changed contracts with appropriate tests: parsing
  failures before requests, streams, schemas, exit codes, non-interactive
  execution, confirmation, previews, pagination, and partial failures as
  relevant. Never exercise live mutations merely to test CLI behavior.

## Command specification template

- `CLI-SPEC-1` MUST specify each new or changed command using these fields,
  either in its command registry or a document. Reference shared policies
  instead of duplicating them. Record exceptions with rule IDs and reasons.

~~~yaml
command: tool articles update
summary: Update article metadata and localized content.
arguments:
  - name: article-id
    type: string
    required: true
options:
  - name: title
    type: string
  - name: body-file
    type: path
    stdin: true
  - name: locale
    type: string
    default: selected profile locale
validation:
  - Require at least one changed field.
  - Reject unknown options and conflicting input sources.
authentication:
  profile: required
  permissions: [article-write]
effects:
  kind: remote-mutation
  confirmation: required
  dry-run: supported
  atomic: false
  sequence:
    - Update metadata when supplied.
    - Update localized content when supplied.
output:
  json-schema: schemas/articles-update-result.json
  partial-result-schema: schemas/articles-update-partial.json
  human: Article ID, locale, and changed fields.
pagination: not-applicable
failures:
  - INVALID_ARGUMENT
  - AUTHENTICATION_FAILED
  - PERMISSION_DENIED
  - NOT_FOUND
  - PARTIAL_FAILURE
retry:
  automatic: false
  reason: Multiple writes can partially succeed.
examples:
  - tool articles update 789 --title "Reset your password" --dry-run
  - tool articles update 789 --title "Reset your password" --yes
compatibility:
  deprecated-aliases: [article edit]
  removal-release: REQUIRED_BEFORE_SHIPPING_ALIAS
exceptions: []
~~~

## References

The numbered rules define this tool's contract. JSON defaults, the envelope, and
exit-code assignments are deliberate choices, not universal Unix requirements.

- [Command Line Interface Guidelines](https://clig.dev/)
- [GNU argument syntax conventions](https://sourceware.org/glibc/manual/2.33/html_node/Argument-Syntax.html)
