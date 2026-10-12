// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { checkProfileName } from "./config.js";
import { usageError } from "./errors.js";
import { usageLine } from "./help.js";
import {
  acceptedGlobals,
  Options,
  type ArgumentSpec,
  type CommandSpec,
  type Context,
  type OptionSpec,
  type OptionValue,
  type Registry,
} from "./registry.js";
import type { ColorMode, GlobalOptions, OutputFormat } from "./types.js";
import { emptyValue, parseChoice, parseDate, parseDuration, parseInteger, parseKeyValue } from "./values.js";

export type Invocation = { kind: "help"; path: string[] } | { kind: "version" } | { kind: "run"; context: Context };

const DEFAULT_TIMEOUT = "30s";

interface RawOption {
  option: OptionSpec;
  values: string[];
}

interface ParsedToken {
  option: OptionSpec;
  value: string | undefined;
  consumedNext: boolean;
}

/** Parses argv against the registry (STYLE-ARGS-*). Throws INVALID_ARGUMENT before any file, credential, or network access. */
export function parseArgv(registry: Registry, argv: readonly string[]): Invocation {
  return new Parser(registry).parse(argv);
}

/** Reads only exact --format and --color tokens, last one wins, so parse errors honor them (STYLE-ERR-6). */
export function prescanPresentation(argv: readonly string[]): { format: OutputFormat; color: ColorMode } {
  const end = argv.indexOf("--");
  const tokens = end < 0 ? argv : argv.slice(0, end);
  const format = lastValue(tokens, "--format");
  const color = lastValue(tokens, "--color");
  const validFormat = format === undefined || ["json", "pretty", "human"].includes(format);
  const validColor = color === undefined || ["auto", "always", "never"].includes(color);
  if (!validFormat || !validColor) return { format: "human", color: "auto" };
  return { format: (format ?? "human") as OutputFormat, color: (color ?? "auto") as ColorMode };
}

function lastValue(tokens: readonly string[], name: string): string | undefined {
  let found: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === name) found = tokens[index + 1];
    if (token.startsWith(`${name}=`)) found = token.slice(name.length + 1);
  }
  return found;
}

function isOptionToken(token: string): boolean {
  return token.startsWith("-") && token !== "-";
}

function optionsByName(options: readonly OptionSpec[]): Map<string, OptionSpec> {
  return new Map(options.map((option) => [option.name, option]));
}

class Parser {
  private readonly bin: string;

  constructor(private readonly registry: Registry) {
    this.bin = registry.bin;
  }

  parse(argv: readonly string[]): Invocation {
    const separator = argv.indexOf("--");
    const head = separator < 0 ? [...argv] : argv.slice(0, separator);
    const tail = separator < 0 ? [] : argv.slice(separator + 1);
    const wordIndexes = this.leadingWordIndexes(head);
    const words = wordIndexes.map((index) => head[index] ?? "");
    const match = this.matchPath(words);
    if (head.includes("--help") || head.includes("-h")) {
      return { kind: "help", path: match.spec ? match.spec.path : words.slice(0, match.length) };
    }
    if (!match.spec) return this.parseWithoutCommand(head, tail, words, match.length);
    const consumed = new Set(wordIndexes.slice(0, match.length));
    const collected = this.collectOptions(head, tail, consumed, match.spec);
    this.checkArguments(match.spec, collected.positionals);
    return { kind: "run", context: this.buildContext(match.spec, collected.positionals, collected.options) };
  }

  private leadingWordIndexes(head: readonly string[]): number[] {
    const indexes: number[] = [];
    for (let index = 0; index < head.length; index += 1) {
      if (isOptionToken(head[index] ?? "")) break;
      indexes.push(index);
    }
    return indexes;
  }

  private matchPath(words: readonly string[]): { length: number; spec?: CommandSpec } {
    for (let length = words.length; length > 0; length -= 1) {
      const prefix = words.slice(0, length);
      if (this.registry.under(prefix).length === 0) continue;
      const spec = this.registry.find(prefix);
      return spec ? { length, spec } : { length };
    }
    return { length: 0 };
  }

  private parseWithoutCommand(head: readonly string[], tail: readonly string[], words: readonly string[], matched: number): Invocation {
    if (words.length > 0 && head.includes("--version")) throw this.versionError(words);
    const group = words.length > 0 && words.length === matched;
    if (words.length > 0 && !group) throw this.resolutionError(words, matched);
    const root = optionsByName(acceptedGlobals("root"));
    const seen = new Map<string, RawOption>();
    for (let index = group ? words.length : 0; index < head.length; index += 1) {
      const token = head[index] ?? "";
      if (!isOptionToken(token)) throw group ? this.resolutionError([...words, token], matched) : this.rootWordError(head);
      const parsed = this.parseOptionToken(token, head[index + 1], root, undefined);
      if (parsed.consumedNext) index += 1;
      this.record(seen, parsed.option, parsed.value);
    }
    if (tail.length > 0) throw this.resolutionError(group ? [...words, tail[0] ?? ""] : [tail[0] ?? ""], group ? matched : 0);
    this.checkConflicts(seen, undefined);
    if (group) return { kind: "help", path: [...words] };
    return seen.has("version") ? { kind: "version" } : { kind: "help", path: [] };
  }

  private rootWordError(head: readonly string[]) {
    const words = head.filter((token) => !isOptionToken(token));
    if (!head.includes("--version")) return this.resolutionError([words[0] ?? ""], 0);
    const match = this.matchPath(words);
    return this.versionError(match.spec ? match.spec.path : words.slice(0, Math.max(match.length, 1)));
  }

  private versionError(words: readonly string[]) {
    return usageError(`--version is not valid for "${words.join(" ")}".`, `Run '${this.bin} --version' without a command.`);
  }

  private resolutionError(words: readonly string[], matched: number) {
    if (matched === 0) {
      return usageError(`Unknown command "${words[0] ?? ""}".`, `Run '${this.bin} --help' for the command list.`);
    }
    const group = words.slice(0, matched).join(" ");
    const expected = this.registry.nextWords(words.slice(0, matched)).join(", ");
    const hint = `Run '${this.bin} ${group} --help'.`;
    return usageError(`Unknown action "${words[matched]}" for "${group}". Expected one of: ${expected}.`, hint);
  }

  private parseOptionToken(
    token: string,
    next: string | undefined,
    table: Map<string, OptionSpec>,
    spec: CommandSpec | undefined,
    nextIsConsumed = false,
  ): ParsedToken {
    const separator = token.indexOf("=");
    const hasInline = token.startsWith("--") && separator >= 0;
    const name = token.startsWith("--") ? token.slice(2, hasInline ? separator : undefined) : this.shortName(token, table);
    const option = name === undefined ? undefined : table.get(name);
    if (!option) {
      if (token === "--version" && spec) throw this.versionError(spec.path);
      throw this.unknownOption(token, spec);
    }
    if (option.type === "boolean") {
      if (hasInline) throw usageError(`--${option.name} does not take a value.`, `Use --${option.name} without a value.`);
      return { option, value: undefined, consumedNext: false };
    }
    if (hasInline) return { option, value: token.slice(separator + 1), consumedNext: false };
    if (next === undefined || nextIsConsumed || isOptionToken(next)) {
      throw usageError(`Missing value for --${option.name}.`, `Use --${option.name}=VALUE when the value starts with -.`);
    }
    return { option, value: next, consumedNext: true };
  }

  private shortName(token: string, table: Map<string, OptionSpec>): string | undefined {
    if (!/^-[a-z]$/.test(token)) return undefined;
    return [...table.values()].find((option) => option.short === token.slice(1))?.name;
  }

  private unknownOption(token: string, spec: CommandSpec | undefined) {
    const longName = /^--[A-Za-z0-9][^=]*/.exec(token)?.[0];
    const shown = longName ?? token;
    const path = spec ? spec.path : [];
    const scope = longName && spec ? ` for "${path.join(" ")}"` : "";
    return usageError(`Unknown option ${shown}${scope}.`, `Run '${[this.bin, ...path, "--help"].join(" ")}' for its options.`);
  }

  private record(seen: Map<string, RawOption>, option: OptionSpec, value: string | undefined): void {
    const existing = seen.get(option.name);
    if (existing && !option.repeatable) {
      throw usageError(`Option --${option.name} may only be provided once.`, `Remove the extra --${option.name}.`);
    }
    if (existing) {
      existing.values.push(value ?? "");
      return;
    }
    seen.set(option.name, { option, values: [value ?? ""] });
  }

  private collectOptions(
    head: readonly string[],
    tail: readonly string[],
    consumed: Set<number>,
    spec: CommandSpec,
  ): { options: Map<string, RawOption>; positionals: string[] } {
    const table = optionsByName(this.registry.optionTable(spec));
    const options = new Map<string, RawOption>();
    const positionals: string[] = [];
    for (let index = 0; index < head.length; index += 1) {
      if (consumed.has(index)) continue;
      const token = head[index] ?? "";
      if (!isOptionToken(token)) {
        positionals.push(token);
        continue;
      }
      const parsed = this.parseOptionToken(token, head[index + 1], table, spec, consumed.has(index + 1));
      if (parsed.consumedNext) index += 1;
      this.record(options, parsed.option, parsed.value);
    }
    return { options, positionals: [...positionals, ...tail] };
  }

  private checkArguments(spec: CommandSpec, positionals: readonly string[]): void {
    const required = spec.arguments.filter((argument) => !argument.optional);
    const hint = `Usage: ${usageLine(this.bin, spec)}`;
    const label = spec.path.join(" ");
    if (positionals.length < required.length) {
      throw usageError(`Missing argument ${required[positionals.length]?.name ?? ""} for "${label}".`, hint);
    }
    const repeating = spec.arguments.at(-1)?.repeatable === true;
    if (!repeating && positionals.length > spec.arguments.length) {
      throw usageError(`Unexpected argument "${positionals[spec.arguments.length] ?? ""}" for "${label}".`, hint);
    }
    positionals.forEach((value, index) => {
      const argument = this.argumentAt(spec, index);
      if (value === "" && argument) throw emptyValue(argument.name);
    });
    positionals.forEach((value, index) => this.argumentAt(spec, index)?.check?.(value));
  }

  /** The argument a positional fills: the one at its index, or the last when that one repeats. */
  private argumentAt(spec: CommandSpec, index: number): ArgumentSpec | undefined {
    const last = spec.arguments.at(-1);
    if (index >= spec.arguments.length) return last?.repeatable ? last : undefined;
    return spec.arguments[index];
  }

  private buildContext(spec: CommandSpec, args: string[], raw: Map<string, RawOption>): Context {
    const globalNames = new Set(acceptedGlobals(spec.kind).map((option) => option.name));
    const converted: Record<string, OptionValue> = Object.create(null) as Record<string, OptionValue>;
    for (const { option, values: inputs } of raw.values()) {
      const items = inputs.map((input) => this.convert(option, input));
      converted[option.name] = option.repeatable ? (items as string[]) : (items[0] as OptionValue);
    }
    this.checkConflicts(raw, spec);
    const own = Object.fromEntries(Object.entries(converted).filter(([name]) => !globalNames.has(name)));
    return { spec, args, options: new Options(own), globals: this.buildGlobals(converted) };
  }

  private buildGlobals(values: Record<string, OptionValue>): GlobalOptions {
    const profile = values.profile;
    return {
      ...(typeof profile === "string" ? { profile } : {}),
      format: (values.format as OutputFormat | undefined) ?? "human",
      color: (values.color as ColorMode | undefined) ?? "auto",
      quiet: values.quiet === true,
      verbose: values.verbose === true,
      noInput: values["no-input"] === true,
      timeoutMs: typeof values.timeout === "number" ? values.timeout : parseDuration("--timeout", DEFAULT_TIMEOUT),
    };
  }

  private convert(option: OptionSpec, input: string): OptionValue {
    const flag = `--${option.name}`;
    if (option.type === "boolean") return true;
    if (input === "" && !option.allowEmpty) throw emptyValue(flag);
    const value = this.parseTyped(option, flag, input);
    if (option.check && !["string", "path"].includes(option.type)) option.check(input);
    return value;
  }

  private parseTyped(option: OptionSpec, flag: string, input: string): OptionValue {
    switch (option.type) {
      case "integer":
        return parseInteger(flag, input, option.min ?? 1, option.max);
      case "duration":
        return parseDuration(flag, input);
      case "date":
        return parseDate(flag, input);
      case "key-value":
        parseKeyValue(flag, input);
        return input;
      case "enum":
        return parseChoice(flag, input, option.choices ?? []);
      default:
        if (option.name === "profile") return checkProfileName(flag, input);
        return option.check ? option.check(input) : input;
    }
  }

  private checkConflicts(raw: Map<string, RawOption>, spec: CommandSpec | undefined): void {
    for (const { option } of raw.values()) {
      const clash = option.conflicts?.find((name) => raw.has(name));
      if (clash) {
        if (option.name === "file" || clash === "file") {
          const field = option.name === "file" ? clash : option.name;
          throw usageError(`--file cannot be combined with --${field}.`, "Put every field in the file, or drop --file.");
        }
        throw usageError(`--${option.name} cannot be combined with --${clash}.`, `Drop --${option.name} or --${clash}.`);
      }
      const missing = option.requires?.find((name) => !raw.has(name));
      if (missing) {
        throw usageError(`--${option.name} requires --${missing}.`, `Add --${missing}, or drop --${option.name}.`);
      }
    }
    if (!spec) return;
    for (const option of spec.options) {
      if (option.required && !raw.has(option.name)) {
        throw usageError(
          `Missing required option --${option.name} for "${spec.path.join(" ")}".`,
          `Add --${option.name} ${option.placeholder ?? "VALUE"}.`,
        );
      }
    }
  }
}
