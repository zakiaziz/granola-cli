// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { EXIT_CODES } from "./errors.js";
import {
  GLOBAL_OPTIONS,
  UTILITY_GROUPS,
  acceptedGlobals,
  type ArgumentSpec,
  type CommandSpec,
  type OptionSpec,
  type Registry,
} from "./registry.js";
import type { PackageInfo } from "./types.js";

export function version(bin: string, info: PackageInfo): string {
  return `${bin} ${info.version}`;
}

export function helpFor(registry: Registry, info: PackageInfo, path: readonly string[]): string {
  if (path.length === 0) return rootHelp(registry, info);
  const spec = registry.find(path);
  return spec ? commandHelp(registry.bin, spec) : groupHelp(registry, path);
}

export function usageLine(bin: string, spec: CommandSpec): string {
  return `${commandLabel(bin, spec)} [options]`;
}

export function commandLabel(bin: string, spec: CommandSpec): string {
  return [bin, ...spec.path, ...spec.arguments.map(argumentLabel)].join(" ");
}

export function optionLabel(option: OptionSpec): string {
  return `--${option.name}${option.type === "boolean" ? "" : ` ${option.placeholder ?? defaultPlaceholder(option)}`}`;
}

export function optionDescription(option: OptionSpec): string {
  const parts = [option.description];
  if (option.choices) parts.push(`Allowed: ${option.choices.join(", ")}.`);
  if (option.default !== undefined) parts.push(`Default: ${option.default}.`);
  if (option.repeatable) parts.push("Repeatable.");
  if (option.required) parts.push("Required.");
  return parts.join(" ");
}

function argumentLabel(argument: ArgumentSpec): string {
  const name = argument.repeatable ? `${argument.name}...` : argument.name;
  return argument.optional ? `[${name}]` : name;
}

function argumentDescription(argument: ArgumentSpec): string {
  const parts = [argument.description];
  if (argument.choices) parts.push(`Allowed: ${argument.choices.join(", ")}.`);
  if (argument.repeatable) parts.push("Repeatable.");
  if (!argument.optional) parts.push("Required.");
  return parts.join(" ");
}

function rootHelp(registry: Registry, info: PackageInfo): string {
  const { bin } = registry;
  return [
    version(bin, info),
    info.description,
    "",
    "Usage:",
    `  ${bin} <resource> <action> [arguments] [options]`,
    "",
    "Commands:",
    ...columns(registry.resourceWords().map((word) => [word, registry.summaryOf(word)])),
    "",
    "Utility commands:",
    ...columns(UTILITY_GROUPS.map((word) => [word, registry.summaryOf(word)])),
    "",
    "Global options:",
    ...optionRows(GLOBAL_OPTIONS),
    "",
    `Run '${bin} <command> --help' for its actions and options.`,
    "",
  ].join("\n");
}

function groupHelp(registry: Registry, path: readonly string[]): string {
  const { bin } = registry;
  const prefix = path.join(" ");
  const rows = registry.under(path).map((spec) => [commandLabel(bin, spec), spec.summary]);
  return [
    registry.group(path)?.title ?? "",
    "",
    "Usage:",
    `  ${bin} ${prefix} <action> [arguments] [options]`,
    "",
    "Commands:",
    ...columns(rows),
    "",
    `Run '${bin} ${prefix} <action> --help' for options, output, and examples.`,
    "",
  ].join("\n");
}

function commandHelp(bin: string, spec: CommandSpec): string {
  const sections: string[][] = [[spec.summary], ["Usage:", `  ${usageLine(bin, spec)}`]];
  if (spec.arguments.length > 0) {
    const rows = spec.arguments.map((argument) => [argument.name, argumentDescription(argument)]);
    sections.push(["Arguments:", ...columns(rows)]);
  }
  if (spec.options.length > 0) sections.push(["Options:", ...optionRows(spec.options)]);
  sections.push(["Global options:", ...optionRows(acceptedGlobals(spec.kind))]);
  sections.push(["Output:", ...indent(spec.output)]);
  const pagination = paginationText(spec);
  if (pagination) sections.push(["Pagination:", ...indent(pagination)]);
  sections.push(["Effects:", ...indent(effectsText(spec))]);
  sections.push(["Failures:", ...failureRows(spec)]);
  sections.push(["Examples:", ...spec.examples.map((example) => `  ${example}`)]);
  if (spec.exceptions && spec.exceptions.length > 0) {
    sections.push(["Exceptions:", ...columns(spec.exceptions.map((exception) => [exception.rule, exception.reason]))]);
  }
  return `${sections.map((section) => section.join("\n")).join("\n\n")}\n`;
}

function paginationText(spec: CommandSpec): string | undefined {
  if (!spec.pagination) return spec.unpaginated;
  const { max, maxSource, ordering, window } = spec.pagination;
  const limit = maxSource === "tool" ? `Page size limit: ${max}, set by this tool because the provider documents none.` : `Provider limit: ${max} per page.`;
  return [
    `One page by default. ${ordering} ${limit}`,
    "--all follows every cursor. --max-items stops on a page boundary, and meta.next_cursor resumes the read.",
    ...(window === undefined
      ? []
      : [`The provider serves only the first ${window} items. A read that reaches that limit ends with has_more true and a null next_cursor.`]),
  ].join("\n");
}

const EFFECT_LEADS = {
  read: "Read only.",
  "remote-mutation": "Remote mutation. Requires confirmation: --yes or an interactive prompt. Supports --dry-run.",
  "local-write": "Local write to the configuration directory. No confirmation.",
  none: "Prints text. No writes.",
  reference: "Prints built-in reference data. Sends no request and writes nothing.",
} as const;

const WRITE_ACCESS_TEXT = {
  always: "Needs a profile with write access.",
  "mutating-methods": "Mutating methods need a profile with write access.",
} as const;

function effectsText(spec: CommandSpec): string {
  const { kind, summary, atomicity, validation } = spec.effects;
  const access = spec.writeAccess
    ? `${WRITE_ACCESS_TEXT[spec.writeAccess]} A profile with read access fails with PERMISSION_DENIED before anything is sent, --dry-run included.`
    : undefined;
  const dryRun =
    validation === "local and remote read"
      ? "--dry-run reads the target remotely and sends no write, so it needs credentials."
      : "--dry-run validates locally and reads nothing remotely.";
  const preview = kind === "remote-mutation" ? `${dryRun} Preview success does not guarantee that the request succeeds.` : undefined;
  return [EFFECT_LEADS[kind], access, summary, atomicity, preview].filter((part): part is string => part !== undefined).join("\n");
}

function failureRows(spec: CommandSpec): string[] {
  const byExit = new Map<number, string[]>();
  for (const code of spec.failures) {
    const exit = EXIT_CODES[code];
    byExit.set(exit, [...(byExit.get(exit) ?? []), code]);
  }
  const rows = [...byExit.entries()].sort(([left], [right]) => left - right);
  const width = Math.max(...rows.map(([exit]) => String(exit).length));
  return rows.map(([exit, codes]) => `  ${String(exit).padEnd(width)}  ${codes.join(", ")}`);
}

function optionRows(options: readonly OptionSpec[]): string[] {
  const rows = options.map((option) => [`${option.short ? `-${option.short}, ` : "    "}${optionLabel(option)}`, optionDescription(option)]);
  return columns(rows, false);
}

const PLACEHOLDERS: Record<string, string> = {
  integer: "N",
  enum: "VALUE",
  date: "DATE",
  duration: "DURATION",
  path: "PATH",
  "key-value": "KEY=VALUE",
  string: "TEXT",
};

function defaultPlaceholder(option: OptionSpec): string {
  return PLACEHOLDERS[option.type] ?? "VALUE";
}

function columns(rows: readonly (readonly string[])[], trim = true): string[] {
  const width = Math.max(...rows.map(([left]) => (left ?? "").length));
  return rows.map(([left, right]) => {
    const line = `  ${(left ?? "").padEnd(width)}  ${right ?? ""}`;
    return trim ? line.trimEnd() : line;
  });
}

function indent(text: string): string[] {
  return text.split("\n").map((line) => `  ${line}`);
}
