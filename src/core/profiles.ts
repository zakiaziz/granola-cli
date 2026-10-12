// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import type { Tool } from "./access.js";
import { stdinCarriesContent } from "./client.js";
import { canPrompt, promptHidden, promptVisible } from "./confirm.js";
import { ACCESS_KEY, ACCESS_LEVELS, checkProfileName, CONFIG_KEYS, isAccessLevel, type Profile } from "./config.js";
import { credentialNoun, credentialOptionsText, fieldOption, fieldSets, isPerRequest, isSecret, setLabel, type FieldSet } from "./credentials.js";
import { asCliError, CliError, usageError, type ErrorCode } from "./errors.js";
import { baseUrlExample, derivingField, endpointFields, fieldConstraint, fieldExample, fieldPlaceholder, kebab, upperSnake } from "./fields.js";
import { printDiagnostic, printResult } from "./output.js";
import type { EndpointField, Provider, SecretField } from "./provider.js";
import { failureList, type ArgumentSpec, type CommandSpec, type Context, type OptionSpec } from "./registry.js";
import {
  baseUrlConstraint,
  baseUrlRule,
  echoable,
  invalidValue,
  listWords,
  missingFields,
  readInput,
  REDACTED,
  redactCredentials,
} from "./values.js";

const PROFILE_FILE_NOTE = "Profile files are written with mode 0600 in directories with mode 0700.";
const ACCESS_EFFECT = "read blocks every remote mutation before anything is sent; write allows mutations.";
const READS_CONFIG_DIRECTORY = "Reads the configuration directory only.";
const LOCAL_FAILURES: ErrorCode[] = ["INVALID_ARGUMENT", "CONFIGURATION_ERROR"];
const checkName = (value: string): string => checkProfileName("NAME", value);
const NEW_PROFILE_NAME: ArgumentSpec = { name: "NAME", description: "Profile name.", check: checkName };
const SAVED_PROFILE_NAME: ArgumentSpec = { name: "NAME", description: "Profile name.", completion: "profiles", check: checkName };

/** Builds the setup, profiles, and config command specs (STYLE-GRAM-6). Every string here is shared by all tools. */
export function profileCommands(tool: Tool): CommandSpec[] {
  return new ProfileCommands(tool).commands();
}

class ProfileCommands {
  private readonly provider: Provider;
  private readonly bin: string;
  private readonly sets: FieldSet[];
  private readonly settings: readonly EndpointField[];

  constructor(private readonly tool: Tool) {
    this.provider = tool.provider;
    this.bin = tool.provider.bin;
    this.sets = fieldSets(tool.provider);
    this.settings = endpointFields(tool.provider);
  }

  commands(): CommandSpec[] {
    return [this.setupSpec(), ...this.profileSpecs(), ...this.configSpecs()];
  }

  // Option specs

  private credentialOptionName(field: SecretField): string {
    return fieldOption(field).name;
  }

  private credentialOptions(): OptionSpec[] {
    return this.sets.flatMap((set) =>
      set.fields.map((field): OptionSpec => {
        if (isSecret(field)) {
          return {
            name: this.credentialOptionName(field),
            placeholder: "PATH",
            type: "path",
            description: `Read the ${this.provider.name} ${field.label} from PATH. - reads stdin.`,
          };
        }
        const flag = `--${this.credentialOptionName(field)}`;
        return {
          name: this.credentialOptionName(field),
          placeholder: field.placeholder ?? upperSnake(field.key),
          type: "string",
          description: `${this.provider.name} ${field.label} to store in the profile.`,
          check: (value) => this.checkedCredential(field, flag, value),
        };
      }),
    );
  }

  private baseUrlOption(change: boolean): OptionSpec {
    return {
      name: "base-url",
      placeholder: "URL",
      type: "string",
      description: change ? `Replace the stored ${this.provider.name} API base URL.` : `${this.provider.name} API base URL to store in the profile.`,
      check: (value) => this.checkedBaseUrl("--base-url", value, "--base-url"),
    };
  }

  private settingOptions(change: boolean): OptionSpec[] {
    const deriving = derivingField(this.provider);
    return this.settings.map((field) => {
      const flag = `--${kebab(field.key)}`;
      const lead = change ? `Replace the stored ${field.label}.` : `${this.provider.name} ${field.label} to store in the profile.`;
      const fallback = field.default === undefined ? "" : ` Default when the profile does not set it: ${field.default}.`;
      const derives = field === deriving ? " Chooses the API base URL. Ignored while the profile stores a base URL." : "";
      return {
        name: kebab(field.key),
        placeholder: fieldPlaceholder(field),
        type: "string",
        ...(field.choices ? { choices: field.choices } : {}),
        description: `${lead}${fallback}${derives}`,
        check: (value) => this.checkedSetting(flag, field, value),
        ...(!change && field === deriving ? { conflicts: ["base-url"] } : {}),
      };
    });
  }

  private clearOptions(): OptionSpec[] {
    return [
      {
        name: "clear-base-url",
        type: "boolean",
        conflicts: ["base-url"],
        description: "Remove the stored base URL.",
      },
      ...this.settings.map(
        (field): OptionSpec => ({
          name: `clear-${kebab(field.key)}`,
          type: "boolean",
          conflicts: [kebab(field.key)],
          description: `Remove the stored ${field.label}.${field.default === undefined ? "" : ` The default ${field.default} then applies.`}`,
        }),
      ),
    ];
  }

  /** The --access option of a provider that declares accessLevels. Required where a profile is created without a prompt. */
  private accessOptions(change: boolean, required: boolean): OptionSpec[] {
    if (!this.provider.accessLevels) return [];
    const lead = change ? "Replace the stored access level:" : "Access level to store in the profile:";
    return [
      {
        name: ACCESS_KEY,
        placeholder: "ACCESS",
        type: "enum",
        choices: [...ACCESS_LEVELS],
        ...(required ? { required: true } : {}),
        description: `${lead} ${ACCESS_EFFECT}`,
      },
    ];
  }

  /** requireAccess: profiles create needs --access; setup prompts for it on a terminal instead. */
  private newProfileOptions(requireAccess = false): OptionSpec[] {
    return [...this.credentialOptions(), this.baseUrlOption(false), ...this.settingOptions(false), ...this.accessOptions(false, requireAccess)];
  }

  private updateOptions(): OptionSpec[] {
    return [
      ...this.credentialOptions(),
      this.baseUrlOption(true),
      ...this.settingOptions(true),
      ...this.clearOptions(),
      ...this.accessOptions(true, false),
    ];
  }

  private fieldOptionNames(includeClear: boolean): string[] {
    const options = includeClear ? this.updateOptions() : this.newProfileOptions();
    return options.map((option) => option.name);
  }

  /** The credential options a first example shows: every field of every set. */
  private exampleOptions(): string {
    const credential = this.sets.flatMap((set) =>
      set.fields.map((field) => {
        if (isSecret(field)) return ` --${this.credentialOptionName(field)} ./${this.bin}-${kebab(field.key)}.txt`;
        return ` --${this.credentialOptionName(field)} ${field.example ?? field.placeholder ?? upperSnake(field.key)}`;
      }),
    );
    const deriving = derivingField(this.provider);
    const needsEndpoint = this.provider.baseUrl.default === undefined && deriving?.default === undefined;
    const endpoint = !needsEndpoint ? "" : deriving ? ` --${kebab(deriving.key)} ${fieldExample(deriving)}` : ` --base-url ${baseUrlExample(this.provider)}`;
    const access = this.provider.accessLevels ? ` --${ACCESS_KEY} read` : "";
    return `${credential.join("")}${endpoint}${access}`;
  }

  private endpointLines(): string[] {
    const deriving = derivingField(this.provider);
    const derivedDefault = deriving?.default === undefined ? undefined : deriving.baseUrl?.(deriving.default);
    const fallback = this.provider.baseUrl.default ?? derivedDefault;
    const ending = fallback === undefined ? "then no default, which fails with CONFIGURATION_ERROR" : `then ${fallback}`;
    const lines = [`Endpoint: the base URL${deriving ? ` or the ${deriving.label}` : ""} stored in the profile, ${ending}.`];
    if (deriving) lines.push(`A stored base URL beats the ${deriving.label}.`);
    const others = this.settings.filter((field) => field !== deriving);
    if (others.length === 0) return lines;
    return [...lines, `Settings (${others.map((field) => field.label).join(", ")}): the value stored in the profile, then the default where the setting has one.`];
  }

  // Specs

  private setupSpec(): CommandSpec {
    const noun = credentialNoun(this.provider, this.sets);
    return {
      path: ["setup"],
      summary: "Create and activate a profile.",
      arguments: [{ name: "NAME", description: "Profile name. Default: default.", optional: true, check: checkName }],
      options: this.newProfileOptions(),
      kind: "local",
      effects: {
        kind: "local-write",
        summary: [
          "Creates profile NAME, then makes it the active profile. Fails when the profile exists.",
          "If activation fails, the profile stays saved and setup exits 8 with PARTIAL_FAILURE.",
          `${this.promptText(noun)} Secrets use hidden input. Without a terminal, pass each secret with its --KEY-file PATH option; - reads stdin.${this.visibleNote()}`,
          "Profile selection: --profile NAME, otherwise activeProfile in config.json. Credentials and endpoint settings come only from that profile. A selected or active profile that does not exist fails with CONFIGURATION_ERROR and never falls back.",
          ...this.endpointLines(),
          ...this.accessLines(),
          PROFILE_FILE_NOTE,
        ].join("\n"),
      },
      output: "Resource envelope. data has name, path, and active; meta is empty.",
      failures: failureList([...LOCAL_FAILURES, "AUTHENTICATION_REQUIRED", "CONFLICT", "PARTIAL_FAILURE"]),
      examples: [`${this.bin} setup work${this.exampleOptions()}`],
      run: (context) => this.setup(context),
    };
  }

  private accessLines(): string[] {
    if (!this.provider.accessLevels) return [];
    return [
      `Access: ${ACCESS_EFFECT} There is no default: on a terminal without --no-input, setup prompts for a missing --access; otherwise it fails.`,
    ];
  }

  private promptText(noun: string): string {
    return `On a terminal without --no-input, setup prompts for a missing ${noun}.`;
  }

  private visibleNote(): string {
    const visible = this.provider.secrets.filter((field) => !isSecret(field)).map((field) => field.label);
    return visible.length === 0 ? "" : ` The ${listWords(visible, "and")} uses visible input.`;
  }

  private secretNoun(): string {
    return listWords(
      this.provider.secrets.filter(isSecret).map((field) => field.label),
      "and",
    );
  }

  private profileSpecs(): CommandSpec[] {
    const bin = this.bin;
    const base = { kind: "local" as const, options: [] as OptionSpec[], arguments: [SAVED_PROFILE_NAME] };
    const redacted = this.secretNoun() === "" ? "" : ` with the ${this.secretNoun()} redacted`;
    return [
      {
        ...base,
        path: ["profiles", "list"],
        summary: "List saved profiles.",
        arguments: [],
        effects: { kind: "read", summary: READS_CONFIG_DIRECTORY },
        output: "Collection envelope. data is an array of name and active; meta is empty.",
        unpaginated: "Not paginated. The command lists every saved profile; meta is empty.",
        failures: LOCAL_FAILURES,
        examples: [`${bin} profiles list`, `${bin} profiles list --format json`],
        run: () => this.profilesList(),
      },
      {
        ...base,
        path: ["profiles", "get"],
        summary: "Get one saved profile with secrets redacted.",
        effects: { kind: "read", summary: READS_CONFIG_DIRECTORY },
        output: `Resource envelope. data has name, active, path, and settings${redacted}; meta is empty.`,
        failures: failureList([...LOCAL_FAILURES, "NOT_FOUND"]),
        examples: [`${bin} profiles get work`],
        run: (context) => this.profilesGet(context),
      },
      {
        ...base,
        path: ["profiles", "create"],
        summary: "Create a profile without activating it.",
        arguments: [NEW_PROFILE_NAME],
        options: this.newProfileOptions(true),
        effects: {
          kind: "local-write",
          summary: `Creates profile NAME. Needs at least one field. Fails when the profile exists. ${this.completeNote()}${PROFILE_FILE_NOTE}`,
        },
        output: "Resource envelope. data has name, active, and path; meta is empty.",
        failures: failureList([...LOCAL_FAILURES, "CONFLICT"]),
        examples: [`${bin} profiles create work${this.exampleOptions()}`],
        run: (context) => this.profilesCreate(context),
      },
      {
        ...base,
        path: ["profiles", "update"],
        summary: "Update fields of a profile.",
        options: this.updateOptions(),
        effects: {
          kind: "local-write",
          summary: `Merges the supplied fields into profile NAME and keeps the others. Needs at least one field. ${this.completeNote()}${PROFILE_FILE_NOTE}`,
        },
        output: "Resource envelope. data has name, active, and path; meta is empty.",
        failures: failureList([...LOCAL_FAILURES, "NOT_FOUND"]),
        examples: [
          `${bin} profiles update work --base-url ${baseUrlExample(this.provider)}`,
          ...(this.provider.accessLevels ? [`${bin} profiles update work --${ACCESS_KEY} write`] : []),
        ],
        run: (context) => this.profilesUpdate(context),
      },
      {
        ...base,
        path: ["profiles", "delete"],
        summary: "Delete a profile.",
        effects: { kind: "local-write", summary: "Deletes the profile file permanently. Fails for the active profile." },
        output: "Resource envelope. data has name and deleted; meta is empty.",
        failures: failureList([...LOCAL_FAILURES, "NOT_FOUND", "CONFLICT"]),
        examples: [`${bin} profiles delete old`],
        run: (context) => this.profilesDelete(context),
      },
      {
        ...base,
        path: ["profiles", "use"],
        summary: "Make a profile the active profile.",
        effects: { kind: "local-write", summary: "Sets activeProfile in config.json." },
        output: "Resource envelope. data has name and active; meta is empty.",
        failures: failureList([...LOCAL_FAILURES, "NOT_FOUND"]),
        examples: [`${bin} profiles use work`],
        run: (context) => this.profilesUse(context),
      },
    ];
  }

  private completeNote(): string {
    if (isPerRequest(this.provider)) return "Each credential that is supplied must be complete. ";
    return "A credential that is supplied must be complete. ";
  }

  private configSpecs(): CommandSpec[] {
    const bin = this.bin;
    const base = { kind: "local" as const, options: [] as OptionSpec[], arguments: [] as ArgumentSpec[], failures: LOCAL_FAILURES };
    const key: ArgumentSpec = {
      name: "KEY",
      description: "Configuration key.",
      choices: [...CONFIG_KEYS],
      check: (value) => this.configKey(value),
    };
    return [
      {
        ...base,
        path: ["config", "list"],
        summary: "List every configuration key.",
        effects: { kind: "read", summary: "Reads config.json only." },
        output: `Resource envelope. data has ${listWords([...CONFIG_KEYS], "and")}, null when unset; meta is empty.`,
        examples: [`${bin} config list`],
        run: () => this.configList(),
      },
      {
        ...base,
        path: ["config", "get"],
        summary: "Get one configuration value.",
        arguments: [key],
        effects: { kind: "read", summary: "Reads config.json only." },
        output: "Resource envelope. data has key and value, null when unset; meta is empty.",
        examples: [`${bin} config get activeProfile`],
        run: (context) => this.configGet(context),
      },
      {
        ...base,
        path: ["config", "path"],
        summary: "Get the configuration paths.",
        effects: { kind: "read", summary: "Prints paths only. Reads no files." },
        output: "Resource envelope. data has config_dir and config_path; meta is empty.",
        failures: ["INVALID_ARGUMENT"],
        examples: [`${bin} config path`],
        run: () => this.configPath(),
      },
    ];
  }

  // Handlers

  private async setup(context: Context): Promise<void> {
    this.localDiagnostic();
    const name = context.args[0] ?? "default";
    this.assertNewProfile(name);
    const config = this.tool.store.readConfig();
    const prompting = canPrompt(context.globals, stdinCarriesContent(context));
    if (!prompting) this.requireAccessOption(context);
    const profile = await this.completeProfile(this.optionInput(context), prompting);
    this.tool.store.writeProfile(name, profile);
    try {
      this.tool.store.writeConfig({ ...config, activeProfile: name });
    } catch (error) {
      throw this.activationFailure(name, asCliError(error));
    }
    printResult({ name, path: this.tool.store.profilePath(name), active: true });
  }

  private activationFailure(name: string, failure: CliError): CliError {
    return new CliError("PARTIAL_FAILURE", "1 of 2 steps completed; nothing was rolled back.", {
      hint: `Run '${this.bin} profiles use ${name}' to activate it.`,
      retryable: false,
      details: { cause: failure.code },
      partial: {
        completed: [{ step: "create profile", result: { name, active: false, path: this.tool.store.profilePath(name) } }],
        failed: [{ step: "activate profile", error: { code: failure.code, message: failure.message } }],
        not_attempted: [],
      },
    });
  }

  /** Reads the profile values the options supply. Secret options read their files. */
  private optionInput(context: Context): Profile {
    const input: Profile = {};
    for (const field of this.provider.secrets) {
      const option = this.credentialOptionName(field);
      const value = isSecret(field) ? this.readSecretOption(field, context) : context.options.string(option);
      if (value !== undefined) input[field.key] = value;
    }
    const baseUrl = context.options.string("base-url");
    if (baseUrl !== undefined) input.baseUrl = baseUrl;
    for (const field of this.settings) {
      const value = context.options.string(kebab(field.key));
      if (value !== undefined) input[field.key] = value;
    }
    const access = this.provider.accessLevels ? context.options.string(ACCESS_KEY) : undefined;
    if (access !== undefined) input[ACCESS_KEY] = access;
    return input;
  }

  /** setup without a prompt needs --access, checked before any secret file is read. */
  private requireAccessOption(context: Context): void {
    if (!this.provider.accessLevels || context.options.has(ACCESS_KEY)) return;
    throw usageError(`Missing required option --${ACCESS_KEY} for "setup".`, `Add --${ACCESS_KEY} read or --${ACCESS_KEY} write.`);
  }

  private async promptAccess(): Promise<string> {
    const value = (await promptVisible(this.provider.name, `access (${ACCESS_LEVELS.join(" or ")})`)).trim();
    if (isAccessLevel(value)) return value;
    throw usageError(`The access must be one of ${ACCESS_LEVELS.join(", ")}; received "${echoable(value)}".`, `Enter ${ACCESS_LEVELS.join(" or ")}.`);
  }

  private readSecretOption(field: SecretField, context: Context): string | undefined {
    const path = context.options.string(this.credentialOptionName(field));
    return path === undefined ? undefined : readSecret(field, this.credentialOptionName(field), path);
  }

  /** Completes the credential a new profile stores by prompting where the terminal allows, and asks for a missing endpoint. */
  private async completeProfile(input: Profile, prompting: boolean): Promise<Profile> {
    const profile: Profile = { ...input };
    await this.completeCredential(profile, prompting);
    const deriving = derivingField(this.provider);
    const needsEndpoint = this.provider.baseUrl.default === undefined && deriving?.default === undefined;
    const supplied = profile.baseUrl !== undefined || (deriving !== undefined && profile[deriving.key] !== undefined);
    if (needsEndpoint && !supplied && prompting) await this.promptEndpoint(profile, deriving);
    // Without a prompt, requireAccessOption has already failed a missing --access.
    if (this.provider.accessLevels && profile[ACCESS_KEY] === undefined && prompting) profile[ACCESS_KEY] = await this.promptAccess();
    return profile;
  }

  private async promptEndpoint(profile: Profile, deriving: EndpointField | undefined): Promise<void> {
    const providerName = this.provider.name;
    if (deriving) {
      const value = (await promptVisible(providerName, deriving.label)).trim();
      if (value === "") return;
      const constraint = fieldConstraint(deriving, value);
      if (constraint) throw usageError(`The ${deriving.label} must ${constraint}.`, `Enter a ${deriving.label} such as ${fieldExample(deriving)}.`);
      profile[deriving.key] = value;
      return;
    }
    const value = (await promptVisible(providerName, "base URL")).trim();
    if (value === "") return;
    profile.baseUrl = this.checkedBaseUrl("The base URL", value, "--base-url");
  }

  /**
   * Completes the credential a new profile stores. A single-set provider prompts for the missing fields of its one set.
   * A provider with credential sets prompts for the sets the options supplied, or for every set when none was
   * supplied, where an empty answer skips a set. At least one set must end complete.
   */
  private async completeCredential(profile: Profile, prompting: boolean): Promise<void> {
    const supplied = this.sets.filter((set) => set.fields.some((field) => profile[field.key] !== undefined));
    const perRequest = isPerRequest(this.provider);
    const targets = supplied.length > 0 ? supplied : this.sets;
    const optional = perRequest && supplied.length === 0;
    for (const set of targets) await this.completeSet(profile, set, prompting, optional);
    if (optional && !this.sets.some((set) => set.fields.every((field) => profile[field.key] !== undefined))) {
      throw this.credentialRequired(this.sets[0]?.fields[0]);
    }
  }

  private async completeSet(profile: Profile, set: FieldSet, prompting: boolean, optional: boolean): Promise<void> {
    const missing = set.fields.filter((field) => profile[field.key] === undefined);
    for (const field of missing) {
      const value = prompting ? await this.promptField(field) : "";
      if (value !== "") {
        profile[field.key] = value;
        continue;
      }
      if (optional) {
        for (const item of set.fields) delete profile[item.key];
        return;
      }
      throw this.credentialRequired(field);
    }
  }

  private async promptField(field: SecretField): Promise<string> {
    const providerName = this.provider.name;
    const value = (await (isSecret(field) ? promptHidden(providerName, field.label) : promptVisible(providerName, field.label))).trim();
    const constraint = value === "" ? undefined : field.validate(value);
    if (constraint) throw usageError(`The ${field.label} must ${constraint}.`, `Enter only the ${field.label}.`);
    return value;
  }

  private credentialRequired(field: SecretField | undefined): CliError {
    const perRequest = isPerRequest(this.provider);
    const subject = perRequest || !field ? credentialNoun(this.provider, this.sets) : field.label;
    return new CliError("AUTHENTICATION_REQUIRED", `No ${this.provider.name} ${subject} was provided.`, {
      hint: `Pass ${credentialOptionsText(this.sets, perRequest ? "or" : "and")}, or run setup in a terminal.`,
    });
  }

  private async profilesList(): Promise<void> {
    this.localDiagnostic();
    const active = this.tool.store.readConfig().activeProfile;
    printResult(this.tool.store.listProfileNames().map((name) => ({ name, active: name === active })));
  }

  private async profilesGet(context: Context): Promise<void> {
    this.localDiagnostic();
    const name = this.profileName(context);
    const profile = this.requireProfile(name);
    const secretKeys = this.provider.secrets.filter(isSecret).map((field) => field.key);
    const keys = [
      ...this.provider.secrets.map((field) => field.key),
      "baseUrl",
      ...this.settings.map((field) => field.key),
      ...(this.provider.accessLevels ? [ACCESS_KEY] : []),
    ];
    const settings = Object.fromEntries(
      keys.map((key) => {
        const value = profile[key];
        if (value === undefined) return [key, null];
        return [key, secretKeys.includes(key) ? REDACTED : value];
      }),
    );
    printResult({ name, active: this.isActive(name), path: this.tool.store.profilePath(name), settings });
  }

  private async profilesCreate(context: Context): Promise<void> {
    this.localDiagnostic();
    const name = this.profileName(context);
    if (!this.hasProfileField(context)) {
      throw missingFields("profiles create", this.fieldOptionNames(false), false);
    }
    this.assertNewProfile(name);
    const active = this.isActive(name);
    const profile = this.optionInput(context);
    this.assertCompleteCredential(profile);
    this.tool.store.writeProfile(name, profile);
    printResult({ name, active, path: this.tool.store.profilePath(name) });
  }

  private async profilesUpdate(context: Context): Promise<void> {
    this.localDiagnostic();
    const name = this.profileName(context);
    const clears = this.clearedKeys(context);
    if (!this.hasProfileField(context) && clears.length === 0) {
      throw missingFields("profiles update", this.fieldOptionNames(true), true);
    }
    const existing = this.requireProfile(name);
    const active = this.isActive(name);
    const supplied = this.optionInput(context);
    const merged: Profile = { ...existing, ...supplied };
    for (const key of clears) delete merged[key];
    this.assertCompleteCredential(merged);
    this.tool.store.writeProfile(name, merged);
    printResult({ name, active, path: this.tool.store.profilePath(name) });
  }

  /** The profile keys a --clear-* option removes. */
  private clearedKeys(context: Context): string[] {
    const keys = ["baseUrl", ...this.settings.map((field) => field.key)];
    return keys.filter((key) => context.options.flag(`clear-${kebab(key)}`));
  }

  /** Rejects a profile that stores part of a credential: a partial set could never authenticate. */
  private assertCompleteCredential(profile: Profile): void {
    const complete = (set: FieldSet): boolean => set.fields.every((field) => profile[field.key] !== undefined);
    const partial = this.sets.find((set) => set.fields.some((field) => profile[field.key] !== undefined) && !complete(set));
    if (!partial) return;
    const missing = partial.fields.filter((field) => profile[field.key] === undefined);
    throw usageError(
      `The ${setLabel(partial)} must be complete; ${listWords(missing.map((field) => field.label), "and")} ${missing.length > 1 ? "are" : "is"} missing.`,
      `Add ${credentialOptionsText([{ name: partial.name, fields: missing }])}.`,
    );
  }

  private async profilesDelete(context: Context): Promise<void> {
    this.localDiagnostic();
    const name = this.profileName(context);
    this.requireProfile(name);
    if (this.isActive(name)) {
      throw new CliError("CONFLICT", `Profile "${name}" is the active profile.`, {
        hint: `Run '${this.bin} profiles use OTHER' first.`,
      });
    }
    this.tool.store.deleteProfile(name);
    printResult({ name, deleted: true });
  }

  private async profilesUse(context: Context): Promise<void> {
    this.localDiagnostic();
    const name = this.profileName(context);
    this.requireProfile(name);
    this.tool.store.writeConfig({ ...this.tool.store.readConfig(), activeProfile: name });
    printResult({ name, active: true });
  }

  private async configPath(): Promise<void> {
    this.localDiagnostic();
    printResult({ config_dir: this.tool.store.dir(), config_path: this.tool.store.configPath() });
  }

  private async configList(): Promise<void> {
    this.localDiagnostic();
    const config = this.tool.store.readConfig();
    printResult({ activeProfile: config.activeProfile ?? null });
  }

  private async configGet(context: Context): Promise<void> {
    this.localDiagnostic();
    const key = context.args[0] ?? "";
    printResult({ key, value: this.tool.store.readConfig().activeProfile ?? null });
  }

  // Helpers

  private localDiagnostic(): void {
    printDiagnostic("config", { config_dir: this.tool.store.dir(), config_path: this.tool.store.configPath() });
  }

  private profileName(context: Context): string {
    return context.args[0] ?? "";
  }

  private isActive(name: string): boolean {
    return this.tool.store.readConfig().activeProfile === name;
  }

  private assertNewProfile(name: string): void {
    if (this.tool.store.readProfile(name) === undefined) return;
    throw new CliError("CONFLICT", `Profile "${name}" already exists.`, {
      hint: `Run '${this.bin} profiles update ${name}' to change it.`,
    });
  }

  private requireProfile(name: string): Profile {
    const profile = this.tool.store.readProfile(name);
    if (profile) return profile;
    throw new CliError("NOT_FOUND", `Profile "${name}" does not exist.`, {
      hint: `Run '${this.bin} profiles list' or '${this.bin} setup ${name}'.`,
    });
  }

  private hasProfileField(context: Context): boolean {
    return this.fieldOptionNames(false).some((name) => context.options.has(name));
  }

  private checkedBaseUrl(subject: string, value: string, detailSubject: string): string {
    const { allowPath } = this.provider.baseUrl;
    const constraint = baseUrlConstraint(value, allowPath);
    if (!constraint) return value;
    const received = echoable(redactCredentials(value));
    const kind = detailSubject.startsWith("--") ? "option" : "argument";
    throw usageError(`${subject} must ${constraint}; received "${received}".`, `Use an https URL such as ${baseUrlExample(this.provider)}.`, {
      [kind]: detailSubject,
      received,
      allowed: baseUrlRule(allowPath),
    });
  }

  private checkedSetting(subject: string, field: EndpointField, value: string): string {
    const constraint = fieldConstraint(field, value);
    if (!constraint) return value;
    const hint = `Use ${subject.startsWith("--") ? `${subject} ` : ""}${fieldExample(field)}.`;
    throw invalidValue(subject, constraint, echoable(value), hint, field.choices?.join(", "));
  }

  private checkedCredential(field: SecretField, flag: string, value: string): string {
    const constraint = field.validate(value);
    if (!constraint) return value;
    throw invalidValue(flag, constraint, echoable(value), `Use ${flag} ${field.example ?? field.placeholder ?? upperSnake(field.key)}.`);
  }

  private configKey(value: string): string {
    const found = CONFIG_KEYS.find((key) => key === value);
    if (found) return found;
    throw usageError(`KEY must be one of ${CONFIG_KEYS.join(", ")}; received "${echoable(value)}".`, `Run '${this.bin} config list' for every key.`, {
      argument: "KEY",
      received: echoable(value),
      allowed: CONFIG_KEYS.join(", "),
    });
  }
}

function readSecret(field: SecretField, option: string, path: string): string {
  const flag = `--${option}`;
  const value = readInput(flag, path).trim();
  const constraint = value === "" ? `contain a nonempty ${field.label}` : field.validate(value);
  if (!constraint) return value;
  throw usageError(`${flag} must ${constraint}.`, `Put only the ${field.label} in the file.`);
}
