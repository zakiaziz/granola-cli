// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import type { Endpoint } from "./access.js";
import type { Client } from "./client.js";
import type { ErrorCode } from "./errors.js";
import type { ArgumentSpec, Context, Effects, Exception, GroupSpec, OptionSpec, PaginationSpec } from "./registry.js";
import type { HttpMethod } from "./types.js";

/**
 * Everything a tool supplies. The core derives every user-visible string from
 * these fields, so a tool cannot change shared wording.
 */
export interface Provider {
  /** Executable name, such as "granola". Names the config directory and prefixes environment variables. */
  bin: string;
  /** Provider display name, such as "Granola". */
  name: string;
  /**
   * Credential profile fields. Each becomes <BIN>_<KEY>. A secret field also becomes --<key>-file PATH and a hidden
   * prompt on setup and profiles create|update; a field with secret: false becomes --<key> VALUE and a plain prompt.
   */
  secrets: SecretField[];
  /** Groups the credential fields into sets. Default: one set holding every field. */
  credentialSets?: CredentialSet[];
  /**
   * How a request picks its credential set. "first-complete" (default): the first complete set of the first source
   * that supplies any field serves every request. "per-request": every set is available and each request names the
   * one it needs, through ResourceCommand.credential, VerifyCheck.credential, and --credential on api request.
   */
  credentialSelection?: "first-complete" | "per-request";
  /** How the credential travels, completing "Sends the selected profile credentials ... as <authScheme>". */
  authScheme: string;
  /** Request headers for the selected credential set, keyed by field key. A per-request set passes only its own fields. */
  authorize(credential: Readonly<Record<string, string>>): Record<string, string>;
  /** Values derived from a credential that must be scrubbed from errors, such as an encoded token inside a header. */
  secretValues?(credential: Readonly<Record<string, string>>): string[];
  /** Static, non-secret request headers. They are sent, shown in previews, and never scrubbed. */
  headers?: Readonly<Record<string, string>>;
  baseUrl: BaseUrlRule;
  /**
   * Non-secret settings stored per profile and in config.json: endpoint selectors (API version, region, subdomain)
   * and defaults for a target (default locale). Each becomes <BIN>_<KEY>, a profile and config key, and
   * --<key>, --clear-<key>, and --from-env handling on setup and profiles.
   */
  endpointFields?: EndpointField[];
  /** "graphql": every resource command and auth verify reads GraphQL responses. Default: "rest". Raw api request is never interpreted. */
  protocol?: "rest" | "graphql";
  /** GraphQL only: reads a failure from a mutation root that reports one in-band, such as { success: false, message }. */
  rootFailure?(root: unknown): ProviderErrorDetail | undefined;
  /** Response headers that carry the provider request ID. The first one present wins. */
  requestIdHeader: string | readonly string[];
  /** Reads the provider message, code, and request ID from an error body. Never spreads the body. */
  errorDetail(body: unknown): ProviderErrorDetail;
  /**
   * Maps provider error codes (HTTP error bodies and GraphQL errors) to error codes. Consulted before the status
   * mapping. An unmapped code falls back to the status mapping, then PROVIDER_ERROR.
   */
  errorCodes?: Readonly<Record<string, ErrorCode>>;
  /** Default pagination style. A command can override it with PaginationSpec.style. Required when a command declares pagination without one. */
  pagination?: Pagination;
  /** One check, or several that `auth verify --credential` chooses between. */
  verify: VerifyCheck | VerifyCheck[];
  api: RawApi;
  groups: GroupSpec[];
  commands: ResourceCommand[];
  /** Commands that print built-in reference data and send no request. */
  localCommands?: LocalCommand[];
}

export interface SecretField {
  /** camelCase profile key, such as "apiKey". */
  key: string;
  /** Lowercase noun for help and errors, such as "API key". */
  label: string;
  /** Returns the failed constraint, such as "contain only visible ASCII characters without spaces". */
  validate(value: string): string | undefined;
  /** False for a credential part that is not secret, such as an email: plain option, plain prompt, never redacted. Default: true. */
  secret?: boolean;
  /** Option value placeholder of a non-secret field. Default: the key in upper snake case. */
  placeholder?: string;
  /** Example value of a non-secret field for help examples. Default: the placeholder. */
  example?: string;
}

/** Credential fields that travel together. */
export interface CredentialSet {
  /** Lowercase kebab-case name, shown as a --credential choice. */
  name: string;
  /** Field keys. Sets partition the credential fields: each field belongs to exactly one set. */
  fields: string[];
}

export interface EndpointField {
  /** camelCase key, such as "apiVersion". Names the profile key, config key, <BIN>_API_VERSION, and --api-version. */
  key: string;
  /** Lowercase noun for help and errors, such as "API version". */
  label: string;
  /** Option value placeholder. Default: the key in upper snake case. */
  placeholder?: string;
  /** Example value for help text. Default: default, then the first choice, then the placeholder. */
  example?: string;
  /** Applies when no environment variable, profile, or config.json sets the field. */
  default?: string;
  /** Allowed values. Replaces validate. */
  choices?: string[];
  /** Returns the failed constraint, such as "match YYYY-MM". */
  validate?(value: string): string | undefined;
  /**
   * Makes the field choose the base URL, for example a subdomain or region. Within one source a stored base URL
   * wins over the field. At most one field can do this.
   */
  baseUrl?(value: string): string;
}

export interface BaseUrlRule {
  /** Omit when the provider has no shared host. Resolution then fails CONFIGURATION_ERROR until a source sets a base URL. */
  default?: string;
  /** Example for help and hints. Required when there is no default and no field derives the base URL. */
  example?: string;
  /**
   * True only when the base URL is the complete endpoint, such as a GraphQL URL with a path.
   * Requests then go to the base URL unchanged and request paths are not appended.
   */
  allowPath: boolean;
}

export interface ProviderErrorDetail {
  message?: string;
  code?: string | number;
  requestId?: string;
}

export interface PageRequest {
  size: number;
  cursor: string | null;
}

/** The part of a collection request that a page can change. The core passes a copy of the body for every page. */
export interface PagedRequest {
  query: URLSearchParams;
  body: unknown;
}

export interface PageInfo {
  nextCursor: string | null;
  /** Overrides the has_more derived from nextCursor, for a read the provider caps with more results remaining. */
  hasMore?: boolean;
  /** Provider collection metadata not encoded by the cursor, kept under meta.provider. */
  provider?: Record<string, unknown>;
}

export interface Pagination {
  /** Writes the page size and cursor into the query or the body of a collection request. */
  apply(request: PagedRequest, page: PageRequest): void;
  /**
   * Reads the continuation from a page, or returns undefined when the fields break the contract. payload is the
   * object the collection was taken from (the array itself when the collection is the response root), or the select
   * input when the command declares select. items are the page items. page is the request that produced them.
   */
  read(payload: unknown, collectionKey: string | undefined, page: PageRequest, items: unknown[]): PageInfo | undefined;
  /** Validates a --cursor value while arguments are parsed. Returns the value or throws INVALID_ARGUMENT. */
  checkCursor?(value: string): string;
  /** Combines meta.provider of two pages during --all. Default: the last page wins. */
  mergeProvider?(previous: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown>;
  /** The cursor is a counter (page number or offset): two pages with identical items fail INVALID_RESPONSE. */
  detectRepeatedPages?: boolean;
}

export interface VerifyCheck {
  method: HttpMethod;
  /** The request path. A function reads resolved endpoint fields, such as an API version. */
  path: string | ((endpoint: Endpoint) => string);
  query: [string, string][];
  /** JSON request body, such as a GraphQL query. */
  body?: unknown;
  /** GraphQL root field the check reads. identity and validate then receive its value. */
  field?: string;
  /** Credential set the check uses. Required for every check when the provider selects credentials per request. */
  credential?: string;
  /** The check text in the output. Default: METHOD PATH?QUERY. */
  label?: string;
  /** Effects text for 'auth verify --help': what the check sends and what success proves. */
  effect: string;
  /** Throws INVALID_RESPONSE when the response does not have the expected shape. */
  validate?(data: unknown): void;
  /** Extracts the caller identity from the response, when the check returns one. */
  identity?(data: unknown): unknown;
}

export interface RawApi {
  methods: readonly HttpMethod[];
  /**
   * The provider serves one GraphQL endpoint (STYLE-API-1). api request then accepts POST /graphql only: any other
   * PATH fails INVALID_ARGUMENT, and the core records the STYLE-API-1 exception in help. methods must be ["POST"],
   * and a provider with protocol "graphql" must set it.
   */
  graphql?: true;
  /** Validates the --file body and makes --file required. Throws INVALID_ARGUMENT. Every method must change state. */
  bodyCheck?(body: unknown): void;
  examples: string[];
  exceptions?: Exception[];
}

/** What a command does with a response. Shared by single-request commands and the calls of a run hook. */
export interface ResponseShape {
  /** Key of the object that holds the collection array. The result is a collection. */
  collectionKey?: string;
  /** The selected response value is itself the collection array. The result is a collection. */
  collection?: boolean;
  /** Key that wraps the single resource. data is its value; a missing key is INVALID_RESPONSE. */
  resourceKey?: string;
  /** Keys of the object holding the data that move into meta.provider. For single resources and unpaginated collections. */
  providerMeta?: readonly string[];
  /**
   * Chooses the result from the decoded body, or from the GraphQL data object. null and undefined mean no result.
   * It replaces the GraphQL root field and cannot be combined with collectionKey or resourceKey. Throw CliError to fail.
   */
  select?(payload: unknown, context: Context): unknown;
  /**
   * Runs after the response is validated and shaped, and returns the data to print. Throw CliError, for example
   * stepsFailure, to report a partial result. Single-response commands only: a paginated command cannot declare it.
   */
  settle?(result: { data: unknown; payload: unknown }, context: Context): unknown;
}

export interface ResourceCommandBase {
  path: string[];
  summary: string;
  arguments: ArgumentSpec[];
  /** Command options only. The core appends pagination options, --yes, and --dry-run from pagination and effects. */
  options: OptionSpec[];
  effects: Effects;
  output: string;
  /** Credential set the command needs. Required when the provider selects credentials per request, otherwise not allowed. */
  credential?: string;
  /** Error codes beyond the shape-derived ones that the command can fail with, for the help Failures section. */
  failures?: ErrorCode[];
  examples: string[];
  exceptions?: Exception[];
}

/** A command that sends one request. */
export interface RequestCommand extends ResourceCommandBase, ResponseShape {
  method: HttpMethod;
  pagination?: PaginationSpec;
  /** Pagination help for an unpaginated collection: whether the provider returns the full list or caps it. */
  unpaginated?: string;
  /** An empty result (null or an empty array) fails NOT_FOUND. */
  emptyIsNotFound?: boolean;
  request(context: Context, endpoint: Endpoint): RequestSpec;
  run?: never;
}

/** A command that sends several requests, or reads before it writes, through the client. */
export interface RunCommand extends ResourceCommandBase {
  pagination?: PaginationSpec;
  unpaginated?: string;
  /** Sends requests through the client and returns the data to print, or undefined after a dry run. */
  run(context: Context, client: Client): Promise<RunResult | undefined>;
  request?: never;
  method?: never;
}

export type ResourceCommand = RequestCommand | RunCommand;

export interface RunResult {
  data: unknown;
  meta?: Record<string, unknown>;
}

/** A command that prints built-in reference data and sends no request. */
export interface LocalCommand {
  path: string[];
  summary: string;
  arguments: ArgumentSpec[];
  options: OptionSpec[];
  output: string;
  /** Pagination help for a collection result, such as "Not paginated. The command lists every entry." */
  unpaginated?: string;
  examples: string[];
  exceptions?: Exception[];
  run(context: Context): RunResult | Promise<RunResult>;
}

export interface RequestSpec {
  path: string;
  query?: [string, string][];
  body?: unknown;
  /** Body shown in dry runs, when the real body carries values that must not print. */
  previewBody?: unknown;
  /** Effect sentence for the confirmation prompt, with identifiers filled in. */
  effect?: string;
  /** GraphQL root field this request reads. The response value of the field becomes the result. */
  field?: string;
  /** Values in the request that are sensitive but not under a sensitive key. Errors scrub them, and previewBody should hide them. */
  secretValues?: string[];
}
