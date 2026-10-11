// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import {
  environmentBaseUrl,
  environmentCredential,
  environmentField,
  type Tool,
} from "./access.js";
import { stdinCarriesContent } from "./client.js";
import { canPrompt, promptHidden, promptVisible } from "./confirm.js";
import { checkProfileName, configKeys, writableConfigKeys, type Profile } from "./config.js";
import { credentialNoun, credentialVariables, fieldSets, isPerRequest, isSecret, setLabel, type FieldSet } from "./credentials.js";
import { asCliError, CliError, usageError, type ErrorCode } from "./errors.js";
import { baseUrlExample, derivingField, endpointFields, fieldConstraint, fieldExample, fieldPlaceholder, kebab, upperSnake, variableName } from "./fields.js";
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
  private readonly baseUrlVariable: string;

  constructor(private readonly tool: Tool) {
    this.provider = tool.provider;
    this.bin = tool.provider.bin;
    this.sets = fieldSets(tool.provider);
    this.settings = endpointFields(tool.provider);
    this.baseUrlVariable = variableName(tool.provider, "baseUrl");
  }

  commands(): CommandSpec[] {
    return [this.setupSpec(), ...this.profileSpecs(), ...this.configSpecs()];
  }

  // Option specs

  private credentialOptionName(field: SecretField): string {
    return isSecret(field) ? `${kebab(field.key)}-file` : kebab(field.key);
  }

  private credentialOptions(): OptionSpec[] {
    return this.sets.flatMap((set, index) =>
      set.fields.map((field): OptionSpec => {
        const earlier = this.sets.slice(0, index).flatMap((other) => other.fields.map((item) => this.credentialOptionName(item)));
        const conflicts = isPerRequest(this.provider) || earlier.length === 0 ? {} : { conflicts: earlier };
        if (isSecret(field)) {
          return {
            name: this.credentialOptionName(field),
            placeholder: "PATH",
            type: "path",
            description: `Read the ${this.provider.name} ${field.label} from PATH. - reads stdin.`,
            ...conflicts,
          };
        }
        const flag = `--${this.credentialOptionName(field)}`;
        return {
          name: this.credentialOptionName(field),
          placeholder: field.placeholder ?? upperSnake(field.key),
          type: "string",
          description: `${this.provider.name} ${field.label} to store in the profile.`,
          check: (value) => this.checkedCredential(field, flag, value),
          ...conflicts,
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
      const fallback = field.default === undefined ? "" : ` Default when no source sets it: ${field.default}.`;
      const derives = field === deriving ? " Chooses the API base URL. Ignored while a base URL is set in the same source." : "";
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
        description: "Remove the stored base URL so the next source in the precedence order applies.",
      },
      ...this.settings.map(
        (field): OptionSpec => ({
          name: `clear-${kebab(field.key)}`,
          type: "boolean",
          conflicts: [kebab(field.key)],
          description: `Remove the stored ${field.label} so the next source in the precedence order applies.`,
        }),
      ),
    ];
  }

  private newProfileOptions(): OptionSpec[] {
    return [...this.credentialOptions(), this.baseUrlOption(false), ...this.settingOptions(false)];
  }

  private updateOptions(): OptionSpec[] {
    return [...this.credentialOptions(), this.baseUrlOption(true), ...this.settingOptions(true), ...this.clearOptions()];
  }

  private fieldOptionNames(includeClear: boolean): string[] {
    const options = includeClear ? this.updateOptions() : this.newProfileOptions();
    return options.map((option) => option.name);
  }

  private variables(): string[] {
    return [
      ...this.provider.secrets.map((field) => variableName(this.provider, field.key)),
      this.baseUrlVariable,
      ...this.settings.map((field) => variableName(this.provider, field.key)),
    ];
  }

  /** The credential options a first example shows: the first set, or every field when sets are all available. */
  private exampleOptions(): string {
    const sets = isPerRequest(this.provider) ? this.sets : this.sets.slice(0, 1);
    const credential = sets.flatMap((set) =>
      set.fields.map((field) => {
        if (isSecret(field)) return ` --${this.credentialOptionName(field)} ./${this.bin}-${kebab(field.key)}.txt`;
        return ` --${this.credentialOptionName(field)} ${field.example ?? field.placeholder ?? upperSnake(field.key)}`;
      }),
    );
    const deriving = derivingField(this.provider);
    const needsEndpoint = this.provider.baseUrl.default === undefined && deriving?.default === undefined;
    const endpoint = !needsEndpoint ? "" : deriving ? ` --${kebab(deriving.key)} ${fieldExample(deriving)}` : ` --base-url ${baseUrlExample(this.provider)}`;
    return `${credential.join("")}${endpoint}`;
  }

  private endpointLines(): string[] {
    const deriving = derivingField(this.provider);
    const derivedDefault = deriving?.default === undefined ? undefined : deriving.baseUrl?.(deriving.default);
    const fallback = this.provider.baseUrl.default ?? derivedDefault;
    const variables = deriving ? `${variableName(this.provider, deriving.key)} or ${this.baseUrlVariable}` : this.baseUrlVariable;
    const ending = fallback === undefined ? "then no default, which fails with CONFIGURATION_ERROR" : `then ${fallback}`;
    const lines = [`Endpoint: ${variables}, the selected profile, config.json, ${ending}.`];
    if (deriving) lines.push(`Within one source a base URL beats the ${deriving.label}.`);
    const others = this.settings.filter((field) => field !== deriving);
    if (others.length === 0) return lines;
    const names = others.map((field) => variableName(this.provider, field.key));
    return [...lines, `Settings (${names.join(", ")}): the environment variable, the selected profile, config.json, then the default where the setting has one.`];
  }

  // Specs

  private setupSpec(): CommandSpec {
    const creating = this.newProfileOptions().map((option) => option.name);
    const noun = credentialNoun(this.provider, this.sets);
    return {
      path: ["setup"],
      summary: "Create and activate a profile.",
      arguments: [{ name: "NAME", description: "Profile name. Default: default.", optional: true, check: checkName }],
      options: [
        ...this.newProfileOptions(),
        {
          name: "from-env",
          type: "boolean",
          conflicts: creating,
          description: `Copy ${listWords(this.variables(), "and")} into the profile.`,
        },
      ],
      kind: "local",
      effects: {
        kind: "local-write",
        summary: [
          "Creates profile NAME, then makes it the active profile. Fails when the profile exists.",
          "If activation fails, the profile stays saved and setup exits 8 with PARTIAL_FAILURE.",
          `On a terminal without --no-input, setup prompts for a missing ${noun}. Secrets use hidden input.${this.visibleNote()}`,
          `Profile selection: --profile, ${variableName(this.provider, "profile")}, then activeProfile in config.json. A selected or active profile that does not exist fails with CONFIGURATION_ERROR and never falls back.`,
          `Credentials: ${credentialVariables(this.provider)}, then the selected profile.`,
          ...this.endpointLines(),
          PROFILE_FILE_NOTE,
        ].join("\n"),
      },
      output: "Resource envelope. data has name, path, and active; meta is empty.",
      failures: failureList([...LOCAL_FAILURES, "AUTHENTICATION_REQUIRED", "CONFLICT", "PARTIAL_FAILURE"]),
      examples: [`${this.bin} setup work${this.exampleOptions()}`, `${this.bin} setup --from-env`],
      run: (context) => this.setup(context),
    };
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
        examples: [`${bin} profiles list`, `${bin} profiles list --format human`],
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
        options: this.newProfileOptions(),
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
          summary: `Merges the supplied fields into profile NAME and keeps the others. Needs at least one field. ${this.replaceNote()}${this.completeNote()}${PROFILE_FILE_NOTE}`,
        },
        output: "Resource envelope. data has name, active, and path; meta is empty.",
        failures: failureList([...LOCAL_FAILURES, "NOT_FOUND"]),
        examples: [`${bin} profiles update work --base-url ${baseUrlExample(this.provider)}`],
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

  private replaceNote(): string {
    if (isPerRequest(this.provider) || this.sets.length < 2) return "";
    return "Supplying the fields of another credential replaces the stored one. ";
  }

  private configSpecs(): CommandSpec[] {
    const bin = this.bin;
    const base = { kind: "local" as const, options: [] as OptionSpec[], arguments: [] as ArgumentSpec[], failures: LOCAL_FAILURES };
    const keys = configKeys(this.provider);
    const writable = writableConfigKeys(this.provider);
    const key: ArgumentSpec = {
      name: "KEY",
      description: "Configuration key.",
      choices: keys,
      check: (value) => this.configKey(value, keys),
    };
    const writableKey: ArgumentSpec = {
      name: "KEY",
      description: "Configuration key. Change activeProfile with profiles use.",
      choices: writable,
      check: (value) => this.writableConfigKey(value),
    };
    const example = this.settings[0];
    const exampleKey = example ? example.key : "baseUrl";
    const exampleValue = example ? fieldExample(example) : baseUrlExample(this.provider);
    return [
      {
        ...base,
        path: ["config", "list"],
        summary: "List every configuration key.",
        effects: { kind: "read", summary: "Reads config.json only." },
        output: `Resource envelope. data has ${listWords(keys, "and")}, null when unset; meta is empty.`,
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
        examples: [`${bin} config get ${exampleKey}`, `${bin} config get activeProfile`],
        run: (context) => this.configGet(context),
      },
      {
        ...base,
        path: ["config", "set"],
        summary: "Set one configuration value.",
        arguments: [writableKey, { name: "VALUE", description: "Literal string value, validated for the key." }],
        effects: { kind: "local-write", summary: "Writes the key to config.json." },
        output: "Resource envelope. data has key and value; meta is empty.",
        examples: [`${bin} config set ${exampleKey} ${exampleValue}`],
        run: (context) => this.configSet(context),
      },
      {
        ...base,
        path: ["config", "unset"],
        summary: "Remove one configuration value.",
        arguments: [writableKey],
        effects: { kind: "local-write", summary: "Removes the key from config.json." },
        output: "Resource envelope. data has key and a null value; meta is empty.",
        examples: [`${bin} config unset ${exampleKey}`],
        run: (context) => this.configUnset(context),
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
    const fromEnvironment = context.options.flag("from-env");
    this.assertNewProfile(name);
    const config = this.tool.store.readConfig();
    const input = fromEnvironment ? this.environmentInput() : this.optionInput(context);
    const prompting = !fromEnvironment && canPrompt(context.globals, stdinCarriesContent(context));
    const profile = await this.completeProfile(input, prompting);
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

  /** Reads the profile values that setup --from-env copies: set credential, base URL, and endpoint variables. */
  private environmentInput(): Profile {
    const input: Profile = { ...(environmentCredential(this.provider)?.values ?? {}) };
    const baseUrl = environmentBaseUrl(this.provider);
    if (baseUrl !== undefined) input.baseUrl = baseUrl;
    for (const field of this.settings) {
      const value = environmentField(this.provider, field);
      if (value !== undefined) input[field.key] = value;
    }
    return input;
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
    return input;
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

  private async completeCredential(profile: Profile, prompting: boolean): Promise<void> {
    const supplied = this.sets.filter((set) => set.fields.some((field) => profile[field.key] !== undefined));
    const perRequest = isPerRequest(this.provider);
    const targets = supplied.length > 0 ? supplied : perRequest ? this.sets : this.sets.slice(0, 1);
    const optional = perRequest && supplied.length === 0;
    for (const set of targets) await this.completeSet(profile, set, prompting, optional);
    if (optional && !this.sets.some((set) => set.fields.every((field) => profile[field.key] !== undefined))) {
      throw this.credentialRequired(this.sets[0]?.fields[0], this.sets.flatMap((set) => set.fields));
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
      throw this.credentialRequired(field, set.fields);
    }
  }

  private async promptField(field: SecretField): Promise<string> {
    const providerName = this.provider.name;
    const value = (await (isSecret(field) ? promptHidden(providerName, field.label) : promptVisible(providerName, field.label))).trim();
    const constraint = value === "" ? undefined : field.validate(value);
    if (constraint) throw usageError(`The ${field.label} must ${constraint}.`, `Enter only the ${field.label}.`);
    return value;
  }

  private credentialRequired(field: SecretField | undefined, fields: readonly SecretField[]): CliError {
    const options = fields.map((item) => (isSecret(item) ? `--${this.credentialOptionName(item)} PATH` : `--${this.credentialOptionName(item)} ${item.placeholder ?? upperSnake(item.key)}`));
    const variables = fields.map((item) => variableName(this.provider, item.key));
    const conjunction = isPerRequest(this.provider) ? "or" : "and";
    const subject = field && !isPerRequest(this.provider) ? field.label : credentialNoun(this.provider, this.sets);
    return new CliError("AUTHENTICATION_REQUIRED", `No ${this.provider.name} ${subject} was provided.`, {
      hint: `Pass ${listWords(options, conjunction)}, set ${listWords(variables, conjunction)} with --from-env, or run setup in a terminal.`,
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
    const keys = [...this.provider.secrets.map((field) => field.key), "baseUrl", ...this.settings.map((field) => field.key)];
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
    const merged: Profile = { ...this.withoutReplacedCredential(existing, supplied), ...supplied };
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

  /**
   * Supplying the fields of one credential set replaces the stored fields of the others, so a profile never keeps
   * two credentials. Providers that select credentials per request keep every stored set.
   */
  private withoutReplacedCredential(existing: Profile, supplied: Profile): Profile {
    if (isPerRequest(this.provider)) return existing;
    const touched = this.sets.filter((set) => set.fields.some((field) => supplied[field.key] !== undefined));
    if (touched.length === 0) return existing;
    const kept = new Set(touched.flatMap((set) => set.fields.map((field) => field.key)));
    const secrets = this.provider.secrets.map((field) => field.key);
    return Object.fromEntries(Object.entries(existing).filter(([key]) => !secrets.includes(key) || kept.has(key)));
  }

  /** Rejects a profile that stores part of a credential: a partial set could never authenticate. */
  private assertCompleteCredential(profile: Profile): void {
    const sets = this.sets.filter((set) => set.fields.some((field) => profile[field.key] !== undefined));
    const complete = (set: FieldSet): boolean => set.fields.every((field) => profile[field.key] !== undefined);
    const partial = isPerRequest(this.provider) ? sets.find((set) => !complete(set)) : sets.length > 0 && !sets.some(complete) ? sets[0] : undefined;
    if (!partial) return;
    const missing = partial.fields.filter((field) => profile[field.key] === undefined);
    const options = missing.map((field) => (isSecret(field) ? `--${this.credentialOptionName(field)} PATH` : `--${this.credentialOptionName(field)} ${field.placeholder ?? upperSnake(field.key)}`));
    throw usageError(
      `The ${setLabel(partial)} must be complete; ${listWords(missing.map((field) => field.label), "and")} ${missing.length > 1 ? "are" : "is"} missing.`,
      `Add ${listWords(options, "and")}.`,
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
    printResult(Object.fromEntries(configKeys(this.provider).map((key) => [key, config[key] ?? null])));
  }

  private async configGet(context: Context): Promise<void> {
    this.localDiagnostic();
    const key = context.args[0] ?? "";
    printResult({ key, value: this.tool.store.readConfig()[key] ?? null });
  }

  private async configSet(context: Context): Promise<void> {
    this.localDiagnostic();
    const key = context.args[0] ?? "";
    const value = this.checkedConfigValue(key, context.args[1] ?? "");
    this.tool.store.writeConfig({ ...this.tool.store.readConfig(), [key]: value });
    printResult({ key, value });
  }

  private async configUnset(context: Context): Promise<void> {
    this.localDiagnostic();
    const key = context.args[0] ?? "";
    const { [key]: _removed, ...rest } = this.tool.store.readConfig();
    this.tool.store.writeConfig(rest);
    printResult({ key, value: null });
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

  private checkedConfigValue(key: string, value: string): string {
    if (key === "baseUrl") return this.checkedBaseUrl("baseUrl", value, "VALUE");
    const field = this.settings.find((candidate) => candidate.key === key);
    if (!field) return value;
    const constraint = fieldConstraint(field, value);
    if (!constraint) return value;
    throw invalidValue(key, constraint, echoable(value), `Use a ${field.label} such as ${fieldExample(field)}.`, field.choices?.join(", "));
  }

  private configKey(value: string, allowed: readonly string[]): string {
    const found = allowed.find((key) => key === value);
    if (found) return found;
    throw usageError(`KEY must be one of ${allowed.join(", ")}; received "${echoable(value)}".`, `Run '${this.bin} config list' for every key.`, {
      argument: "KEY",
      received: echoable(value),
      allowed: allowed.join(", "),
    });
  }

  private writableConfigKey(value: string): string {
    if (value === "activeProfile") {
      throw usageError("activeProfile is read-only through config set and unset.", `Run '${this.bin} profiles use NAME'.`);
    }
    return this.configKey(value, writableConfigKeys(this.provider));
  }
}

function readSecret(field: SecretField, option: string, path: string): string {
  const flag = `--${option}`;
  const value = readInput(flag, path).trim();
  const constraint = value === "" ? `contain a nonempty ${field.label}` : field.validate(value);
  if (!constraint) return value;
  throw usageError(`${flag} must ${constraint}.`, `Put only the ${field.label} in the file.`);
}
