// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { ERROR_CODES, usageError, type ErrorCode } from "./errors.js";
import type { Pagination } from "./provider.js";
import type { GlobalOptions } from "./types.js";
import { DATE_TIME_FORM, echoable, parseCalendarDate } from "./values.js";

export type OptionType = "boolean" | "string" | "integer" | "enum" | "date" | "duration" | "path" | "key-value";

export interface OptionSpec {
  name: string;
  short?: "h" | "q" | "v" | "y";
  placeholder?: string;
  type: OptionType;
  description: string;
  choices?: string[];
  min?: number;
  max?: number;
  default?: string;
  repeatable?: boolean;
  required?: boolean;
  allowEmpty?: boolean;
  conflicts?: string[];
  requires?: string[];
  /** Validates the value during parsing, before conflicts (STYLE-ARGS-10). */
  check?(value: string): string;
}

export interface ArgumentSpec {
  name: string;
  description: string;
  optional?: boolean;
  /**
   * Takes one or more values, or zero or more when optional, and every value passes check. Only the last argument can
   * repeat, and a repeating argument declares no choices or completion. Context.args holds every value in order.
   */
  repeatable?: boolean;
  choices?: string[];
  completion?: "profiles";
  /** Validates the value during parsing, after the argument count and before option values (STYLE-ARGS-10). */
  check?(value: string): string;
}

export type OptionValue = string | number | boolean | string[];

export class Options {
  constructor(private readonly values: Readonly<Record<string, OptionValue>>) {}

  has(name: string): boolean {
    return Object.hasOwn(this.values, name);
  }

  flag(name: string): boolean {
    return this.value(name) === true;
  }

  string(name: string): string | undefined {
    const value = this.value(name);
    return typeof value === "string" ? value : undefined;
  }

  strings(name: string): string[] {
    const value = this.value(name);
    return Array.isArray(value) ? value : [];
  }

  number(name: string): number | undefined {
    const value = this.value(name);
    return typeof value === "number" ? value : undefined;
  }

  private value(name: string): OptionValue | undefined {
    return this.has(name) ? this.values[name] : undefined;
  }
}

export interface Context {
  spec: CommandSpec;
  args: string[];
  options: Options;
  globals: GlobalOptions;
}

export type CommandKind = "network" | "local" | "text";

export interface Effects {
  /** "reference" prints built-in reference data: no network, no writes. */
  kind: "read" | "remote-mutation" | "local-write" | "none" | "reference";
  summary?: string;
  atomicity?: string;
  /** What --dry-run does for a remote mutation. "local and remote read" when the preview reads the target first. Default: "local". */
  validation?: "local" | "local and remote read";
}

export interface Exception {
  rule: string;
  reason: string;
}

export interface PaginationSpec {
  /** Largest page size the command accepts. */
  max: number;
  default: number;
  ordering: string;
  /**
   * Who sets max. "provider" (default): the provider documents the limit and help says so. "tool": the provider
   * documents no limit and this tool caps the page size itself, which help says instead.
   */
  maxSource?: "provider" | "tool";
  /** The style this command pages with. Default: the provider's pagination. */
  style?: Pagination;
  /**
   * Largest result the provider serves, counted from offset 0. The cursor must be the decimal offset. The core
   * clamps the request size to the window, and a read that reaches it ends with has_more true and next_cursor null.
   */
  window?: number;
}

export interface CommandSpec {
  path: string[];
  summary: string;
  arguments: ArgumentSpec[];
  options: OptionSpec[];
  kind: CommandKind;
  effects: Effects;
  output: string;
  pagination?: PaginationSpec;
  unpaginated?: string;
  failures: ErrorCode[];
  examples: string[];
  exceptions?: Exception[];
  run(context: Context): Promise<void>;
}

export interface GroupSpec {
  path: string[];
  summary: string;
  title: string;
}

export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  { name: "help", short: "h", type: "boolean", description: "Show help. Uses no credentials or network." },
  { name: "version", type: "boolean", description: "Print the executable name and version." },
  { name: "profile", placeholder: "NAME", type: "string", description: "Select a saved profile." },
  {
    name: "format",
    placeholder: "FORMAT",
    type: "enum",
    choices: ["json", "pretty", "human"],
    default: "human",
    description: "Output format.",
  },
  {
    name: "color",
    placeholder: "WHEN",
    type: "enum",
    choices: ["auto", "always", "never"],
    default: "auto",
    description: "Color for pretty and human output.",
  },
  {
    name: "quiet",
    short: "q",
    type: "boolean",
    conflicts: ["verbose"],
    description: "Suppress progress and notices. Results and errors still print.",
  },
  { name: "verbose", short: "v", type: "boolean", description: "Print redacted diagnostics to stderr." },
  { name: "no-input", type: "boolean", description: "Never prompt. Fail when input is missing." },
  {
    name: "timeout",
    placeholder: "DURATION",
    type: "duration",
    default: "30s",
    description: "Per-request timeout in ms, s, or m, from 1ms to 10m.",
  },
];

const GLOBAL_NAMES: Record<CommandKind | "root", readonly string[]> = {
  network: ["help", "profile", "format", "color", "quiet", "verbose", "no-input", "timeout"],
  local: ["help", "format", "color", "quiet", "verbose", "no-input"],
  text: ["help"],
  root: ["help", "version", "verbose", "quiet"],
};

export function acceptedGlobals(kind: CommandKind | "root"): OptionSpec[] {
  return GLOBAL_OPTIONS.filter((option) => GLOBAL_NAMES[kind].includes(option.name));
}

export const YES_OPTION: OptionSpec = {
  name: "yes",
  short: "y",
  type: "boolean",
  description: "Confirm the mutation without prompting.",
};

export const DRY_RUN_OPTION: OptionSpec = {
  name: "dry-run",
  type: "boolean",
  description: "Print a redacted request preview. Sends nothing.",
};

export const FILE_OPTION: OptionSpec = {
  name: "file",
  placeholder: "PATH",
  type: "path",
  description: "Read the complete JSON input from PATH. - reads stdin.",
};

/** The default option that names a credential set when the provider declares credentialSets. */
export const DEFAULT_CREDENTIAL_OPTION: CredentialOptionName = { name: "credential", placeholder: "CREDENTIAL", noun: "credential" };

export interface CredentialOptionName {
  /** Lowercase kebab-case option name, without the dashes. */
  name: string;
  /** Option value placeholder in upper snake case. */
  placeholder: string;
  /** Lowercase noun for what the option selects, completing "<Noun> to send." in help. */
  noun: string;
}

/** The option that names a credential set. required: api request needs one set, auth verify can run every available set. */
export function credentialOption(names: readonly string[], definition: CredentialOptionName, use: "send" | "verify"): OptionSpec {
  const noun = `${definition.noun.charAt(0).toUpperCase()}${definition.noun.slice(1)}`;
  return {
    name: definition.name,
    placeholder: definition.placeholder,
    type: "enum",
    choices: [...names],
    ...(use === "send" ? { required: true } : {}),
    description:
      use === "send" ? `${noun} to send.` : `${noun} to verify. Without it, every ${definition.noun} that the profile stores is verified.`,
  };
}

export const QUERY_OPTION: OptionSpec = {
  name: "query",
  placeholder: "KEY=VALUE",
  type: "key-value",
  repeatable: true,
  description: "Add a query parameter.",
};

export function paginationOptions(pagination: PaginationSpec, style: Pagination | undefined): OptionSpec[] {
  const check = cursorCheck(pagination, style);
  return [
    {
      name: "page-size",
      placeholder: "N",
      type: "integer",
      min: 1,
      max: pagination.max,
      default: String(pagination.default),
      description: `Items per page, from 1 to ${pagination.max}.`,
    },
    {
      name: "cursor",
      placeholder: "TOKEN",
      type: "string",
      description: "Resume from a previous meta.next_cursor.",
      ...(check ? { check } : {}),
    },
    { name: "all", type: "boolean", description: "Fetch every page." },
    {
      name: "max-items",
      placeholder: "N",
      type: "integer",
      min: 1,
      requires: ["all"],
      description: "Stop after N items. Requires --all.",
    },
  ];
}

/** Validates a --cursor while arguments are parsed: the style's own check, then the provider window. */
function cursorCheck(pagination: PaginationSpec, style: Pagination | undefined): ((value: string) => string) | undefined {
  const own = style?.checkCursor?.bind(style);
  const { window } = pagination;
  if (!own && window === undefined) return undefined;
  return (value) => {
    const checked = own ? own(value) : value;
    if (window === undefined || (/^[0-9]{1,15}$/.test(checked) && Number(checked) < window)) return checked;
    throw usageError(
      `--cursor must be a decimal offset less than ${window}; received "${echoable(checked)}".`,
      "Use a meta.next_cursor value from a previous page.",
      { option: "--cursor", received: echoable(checked), allowed: `0-${window - 1}` },
    );
  };
}

export type DateBoundary = "inclusive" | "exclusive" | "undocumented";

const BOUNDARY_TEXT: Record<DateBoundary, string> = {
  inclusive: "Inclusive.",
  exclusive: "Exclusive.",
  undocumented: "Boundary set by the provider and undocumented.",
};

export function dateOption(name: string, subject: string, boundary: DateBoundary): OptionSpec {
  return {
    name,
    placeholder: "DATE",
    type: "date",
    description: `${subject} DATE. Accepts YYYY-MM-DD (00:00 UTC) or ${DATE_TIME_FORM}. ${BOUNDARY_TEXT[boundary]}`,
  };
}

/** A date option for providers that take a calendar date and reject a timestamp. The value stays YYYY-MM-DD. */
export function calendarDateOption(name: string, subject: string, boundary: DateBoundary): OptionSpec {
  return {
    name,
    placeholder: "DATE",
    type: "string",
    description: `${subject} DATE. Accepts YYYY-MM-DD. ${BOUNDARY_TEXT[boundary]}`,
    check: (value) => parseCalendarDate(`--${name}`, value),
  };
}

const NETWORK_FAILURES: readonly ErrorCode[] = [
  "INVALID_ARGUMENT",
  "INVALID_REQUEST",
  "CONFIGURATION_ERROR",
  "AUTHENTICATION_REQUIRED",
  "AUTHENTICATION_FAILED",
  "PERMISSION_DENIED",
  "RATE_LIMITED",
  "TRANSIENT_FAILURE",
  "PROVIDER_ERROR",
  "INVALID_RESPONSE",
];

export function failureList(codes: readonly ErrorCode[]): ErrorCode[] {
  return [...new Set(codes)].sort((left, right) => ERROR_CODES.indexOf(left) - ERROR_CODES.indexOf(right));
}

export function networkFailures(shape: {
  identified: boolean;
  /** The command can stop after part of its work: pagination, several requests, or a settle hook. */
  partial: boolean;
  mutation: boolean;
  extra?: readonly ErrorCode[];
}): ErrorCode[] {
  return failureList([
    ...NETWORK_FAILURES,
    ...(shape.identified ? (["NOT_FOUND"] as const) : []),
    ...(shape.partial ? (["PARTIAL_FAILURE"] as const) : []),
    ...(shape.mutation ? (["CONFLICT", "CONFIRMATION_REQUIRED", "CONFIRMATION_DECLINED"] as const) : []),
    ...(shape.extra ?? []),
  ]);
}

export const UTILITY_GROUPS: readonly string[] = ["setup", "profiles", "config", "auth", "api", "completions"];

const ACTION_ORDER = ["list", "get", "search", "create", "update", "replace", "delete", "archive", "restore"];

function actionRank(action: string): number {
  const index = ACTION_ORDER.indexOf(action);
  if (index >= 0) return index;
  if (action === "export") return ACTION_ORDER.length + 1;
  if (action === "import") return ACTION_ORDER.length + 2;
  if (action.startsWith("batch-")) return ACTION_ORDER.length + 3;
  return ACTION_ORDER.length;
}

export class Registry {
  constructor(
    readonly bin: string,
    readonly commands: readonly CommandSpec[],
    private readonly groups: readonly GroupSpec[],
  ) {}

  find(path: readonly string[]): CommandSpec | undefined {
    return this.commands.find((spec) => spec.path.join(" ") === path.join(" "));
  }

  group(path: readonly string[]): GroupSpec | undefined {
    return this.groups.find((group) => group.path.join(" ") === path.join(" "));
  }

  under(prefix: readonly string[]): CommandSpec[] {
    return this.commands
      .filter((spec) => prefix.every((word, index) => spec.path[index] === word))
      .sort((left, right) => {
        const leftGroup = left.path.slice(0, -1).join(" ");
        const rightGroup = right.path.slice(0, -1).join(" ");
        if (leftGroup !== rightGroup) return leftGroup.localeCompare(rightGroup);
        const byAction = actionRank(left.path.at(-1) ?? "") - actionRank(right.path.at(-1) ?? "");
        return byAction !== 0 ? byAction : this.commands.indexOf(left) - this.commands.indexOf(right);
      });
  }

  nextWords(prefix: readonly string[]): string[] {
    const words = this.under(prefix)
      .map((spec) => spec.path[prefix.length])
      .filter((word): word is string => word !== undefined);
    return [...new Set(words)];
  }

  resourceWords(): string[] {
    const words = this.commands.map((spec) => spec.path[0] ?? "");
    return [...new Set(words)].filter((word) => !UTILITY_GROUPS.includes(word)).sort();
  }

  rootOrder(): string[] {
    return [...this.resourceWords(), ...UTILITY_GROUPS];
  }

  summaryOf(word: string): string {
    return this.group([word])?.summary ?? this.find([word])?.summary ?? "";
  }

  optionTable(spec: CommandSpec): OptionSpec[] {
    return [...spec.options, ...acceptedGlobals(spec.kind)];
  }
}
