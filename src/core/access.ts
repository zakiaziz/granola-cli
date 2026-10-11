// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { checkProfileVariable, type AppConfig, type ConfigStore, type Profile } from "./config.js";
import {
  credentialFor,
  credentialFrom,
  credentialNoun,
  credentialVariables,
  setVariables,
  setsFor,
  type Credential,
  type FieldSet,
} from "./credentials.js";
import { CliError } from "./errors.js";
import { baseUrlExample, derivingField, endpointFields, fieldConstraint, fieldExample, variableName } from "./fields.js";
import type { EndpointField, Provider, SecretField } from "./provider.js";
import type { GlobalOptions } from "./types.js";
import { baseUrlConstraint, baseUrlRule, echoable, emptyVariable, invalidVariable, redactCredentials } from "./values.js";

/** The provider definition and its configuration store, shared by every command handler. */
export interface Tool {
  provider: Provider;
  store: ConfigStore;
}

export interface Access {
  profileName?: string;
  baseUrl: string;
  /** Resolved endpoint fields, with defaults applied. A field with no value and no default is absent. */
  endpoint: Readonly<Record<string, string>>;
  /** The first source that supplies any credential field. */
  credential?: Credential;
}

/**
 * Resolved endpoint fields, such as an API version or default locale. Resolution reads the environment, the
 * selected profile, and config.json on first use, so a command that never reads a field never touches them.
 */
export class Endpoint {
  constructor(
    private readonly provider: Provider,
    private readonly values: () => Readonly<Record<string, string>>,
  ) {}

  /** The value, or undefined when no source sets the field and it has no default. */
  get(key: string): string | undefined {
    return this.values()[this.declared(key).key];
  }

  /** The value. Fails CONFIGURATION_ERROR when no source sets the field. */
  require(key: string): string {
    const field = this.declared(key);
    const value = this.values()[field.key];
    if (value !== undefined) return value;
    throw new CliError("CONFIGURATION_ERROR", `No ${this.provider.name} ${field.label} found.`, {
      hint: `Set ${variableName(this.provider, field.key)}, or run '${this.provider.bin} setup'.`,
    });
  }

  private declared(key: string): EndpointField {
    const field = endpointFields(this.provider).find((candidate) => candidate.key === key);
    if (field) return field;
    throw new CliError("UNEXPECTED_ERROR", `"${key}" is not an endpoint field of ${this.provider.name}.`);
  }
}

export function environmentValue(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (value === "") throw emptyVariable(name);
  return value;
}

export function environmentBaseUrl(provider: Provider): string | undefined {
  const variable = variableName(provider, "baseUrl");
  const value = environmentValue(variable);
  if (value === undefined) return undefined;
  const constraint = baseUrlConstraint(value, provider.baseUrl.allowPath);
  if (!constraint) return value;
  throw invalidVariable(
    variable,
    constraint,
    echoable(redactCredentials(value)),
    `Use an https URL such as ${baseUrlExample(provider)}.`,
    baseUrlRule(provider.baseUrl.allowPath),
  );
}

/** The value of an endpoint field's environment variable, validated, or undefined when it is unset. */
export function environmentField(provider: Provider, field: EndpointField): string | undefined {
  const variable = variableName(provider, field.key);
  const value = environmentValue(variable);
  if (value === undefined) return undefined;
  const constraint = fieldConstraint(field, value);
  if (!constraint) return value;
  throw invalidVariable(variable, constraint, echoable(value), `Set ${variable} to a value such as ${fieldExample(field)}.`);
}

export function environmentSecret(provider: Provider, field: SecretField): string | undefined {
  const variable = variableName(provider, field.key);
  const value = environmentValue(variable);
  if (value === undefined) return undefined;
  const constraint = field.validate(value);
  if (!constraint) return value;
  throw new CliError("CONFIGURATION_ERROR", `${variable} must ${constraint}.`, {
    hint: `Set ${variable} to a valid ${field.label}.`,
  });
}

export function resolveAccess(tool: Tool, globals: GlobalOptions): Access {
  const { provider, store } = tool;
  const config = store.readConfig();
  const profileName = globals.profile ?? environmentProfile(provider) ?? config.activeProfile;
  const profile = profileName === undefined ? undefined : selectedProfile(tool, profileName);
  const credential = environmentCredential(provider) ?? profileCredential(provider, profileName, profile);
  const { baseUrl, endpoint } = resolveEndpoint(provider, profile, config);
  return {
    ...(profileName === undefined ? {} : { profileName }),
    baseUrl,
    endpoint,
    ...(credential ? { credential } : {}),
  };
}

/**
 * Resolves the base URL and endpoint fields (STYLE-CFG-2): environment variable, selected profile, config.json, then
 * the default. Within one source a stored base URL wins over a field that derives the base URL.
 */
function resolveEndpoint(
  provider: Provider,
  profile: Profile | undefined,
  config: AppConfig,
): { baseUrl: string; endpoint: Record<string, string> } {
  const fields = endpointFields(provider);
  const environment: Record<string, string | undefined> = {
    baseUrl: environmentBaseUrl(provider),
    ...Object.fromEntries(fields.map((field) => [field.key, environmentField(provider, field)])),
  };
  const sources: Record<string, string | undefined>[] = [environment, profile ?? {}, config];
  const endpoint: Record<string, string> = {};
  for (const field of fields) {
    const value = sources.map((source) => source[field.key]).find((item) => item !== undefined) ?? field.default;
    if (value !== undefined) endpoint[field.key] = value;
  }
  return { baseUrl: resolveBaseUrl(provider, sources), endpoint };
}

function resolveBaseUrl(provider: Provider, sources: readonly Record<string, string | undefined>[]): string {
  const deriving = derivingField(provider);
  for (const source of sources) {
    const stored = source.baseUrl;
    if (stored !== undefined) return stored;
    const value = deriving ? source[deriving.key] : undefined;
    if (deriving && value !== undefined) return derivedBaseUrl(provider, deriving, value);
  }
  if (provider.baseUrl.default !== undefined) return provider.baseUrl.default;
  if (deriving?.default !== undefined) return derivedBaseUrl(provider, deriving, deriving.default);
  const variables = [deriving ? variableName(provider, deriving.key) : undefined, variableName(provider, "baseUrl")];
  throw new CliError("CONFIGURATION_ERROR", `No ${provider.name} base URL found.`, {
    hint: `Set ${variables.filter((name) => name !== undefined).join(" or ")}, or run '${provider.bin} setup'.`,
  });
}

function derivedBaseUrl(provider: Provider, field: EndpointField, value: string): string {
  const url = field.baseUrl?.(value) ?? "";
  const constraint = baseUrlConstraint(url, provider.baseUrl.allowPath);
  if (!constraint) return url;
  throw new CliError("CONFIGURATION_ERROR", `The ${field.label} "${echoable(value)}" produces a base URL that must ${constraint}; received "${echoable(redactCredentials(url))}".`, {
    hint: `Use a ${field.label} such as ${fieldExample(field)}.`,
  });
}

/** The credential a request sends. Fails AUTHENTICATION_REQUIRED when the request's credential is not available. */
export function requireCredential(provider: Provider, access: Access, setName?: string): Credential {
  const credential = credentialFor(provider, access.credential, setName);
  if (credential) return credential;
  const sets = setsFor(provider, setName);
  throw new CliError("AUTHENTICATION_REQUIRED", `No ${provider.name} ${credentialNoun(provider, sets)} found.`, {
    hint: `Set ${credentialVariables(provider, sets)}, or run '${provider.bin} setup'.`,
  });
}

export function credentialSource(access: Access): "environment" | "profile" | "none" {
  return access.credential?.source ?? "none";
}

export function reportedProfile(access: Access): string | null {
  return access.credential?.source === "profile" ? (access.profileName ?? null) : null;
}

function environmentProfile(provider: Provider): string | undefined {
  const variable = variableName(provider, "profile");
  const name = environmentValue(variable);
  return name === undefined ? undefined : checkProfileVariable(variable, name);
}

function selectedProfile(tool: Tool, name: string): Profile {
  const profile = tool.store.readProfile(name);
  if (profile) return profile;
  const bin = tool.provider.bin;
  throw new CliError("CONFIGURATION_ERROR", `Profile "${name}" does not exist.`, {
    hint: `Run '${bin} profiles list' or '${bin} setup ${name}'.`,
  });
}

function missingText(names: string[]): string {
  return `${names.join(" and ")} ${names.length > 1 ? "are" : "is"} missing`;
}

/** The environment variables that supply credential fields, validated. Unset variables are absent. */
export function environmentFields(provider: Provider): Record<string, string | undefined> {
  return Object.fromEntries(provider.secrets.map((field) => [field.key, environmentSecret(provider, field)]));
}

export function environmentCredential(provider: Provider): Credential | undefined {
  return credentialFrom(provider, environmentFields(provider), "environment", {
    incomplete: (set: FieldSet, missing: SecretField[]) =>
      new CliError(
        "AUTHENTICATION_REQUIRED",
        `The environment supplies an incomplete credential set: ${missingText(missing.map((field) => variableName(provider, field.key)))}.`,
        { hint: `Set ${setVariables(provider, set)} together, or unset them all.` },
      ),
  });
}

function profileCredential(provider: Provider, name: string | undefined, profile: Profile | undefined): Credential | undefined {
  if (name === undefined || profile === undefined) return undefined;
  return credentialFrom(provider, profile, "profile", {
    incomplete: (_set: FieldSet, missing: SecretField[]) =>
      new CliError(
        "AUTHENTICATION_REQUIRED",
        `Profile "${name}" supplies an incomplete credential set: ${missingText(missing.map((field) => field.key))}.`,
        { hint: `Run '${provider.bin} profiles update ${name}' with the missing fields.` },
      ),
  });
}
