// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { type ConfigStore, type Profile } from "./config.js";
import { credentialFor, credentialFrom, credentialNoun, credentialOptionsText, setsFor, type Credential, type FieldSet } from "./credentials.js";
import { CliError } from "./errors.js";
import { baseUrlExample, derivingField, endpointFields, fieldExample, kebab } from "./fields.js";
import type { EndpointField, Provider, SecretField } from "./provider.js";
import type { GlobalOptions } from "./types.js";
import { baseUrlConstraint, echoable, redactCredentials } from "./values.js";

/** The provider definition and its configuration store, shared by every command handler. */
export interface Tool {
  provider: Provider;
  store: ConfigStore;
}

export interface Access {
  /** The profile every credential and endpoint setting comes from. */
  profileName: string;
  baseUrl: string;
  /** Resolved endpoint fields, with defaults applied. A field with no value and no default is absent. */
  endpoint: Readonly<Record<string, string>>;
  /** The credential fields the profile stores. */
  credential?: Credential;
}

/**
 * Resolved endpoint fields, such as an API version or default locale. Resolution reads the selected profile on first
 * use, so a command that never reads a field never touches it.
 */
export class Endpoint {
  constructor(
    private readonly provider: Provider,
    private readonly access: () => Access,
  ) {}

  /** The value, or undefined when the profile does not set the field and it has no default. */
  get(key: string): string | undefined {
    return this.access().endpoint[this.declared(key).key];
  }

  /** The value. Fails CONFIGURATION_ERROR when the profile does not set the field and it has no default. */
  require(key: string): string {
    const field = this.declared(key);
    const access = this.access();
    const value = access.endpoint[field.key];
    if (value !== undefined) return value;
    throw new CliError("CONFIGURATION_ERROR", `Profile "${access.profileName}" has no ${field.label}.`, {
      hint: `Run '${this.provider.bin} profiles update ${access.profileName} --${kebab(field.key)} ${fieldExample(field)}'.`,
    });
  }

  private declared(key: string): EndpointField {
    const field = endpointFields(this.provider).find((candidate) => candidate.key === key);
    if (field) return field;
    throw new CliError("UNEXPECTED_ERROR", `"${key}" is not an endpoint field of ${this.provider.name}.`);
  }
}

/**
 * Resolves the profile (STYLE-CFG-2): --profile, otherwise activeProfile in config.json. Every credential and endpoint
 * setting then comes from that profile, and the built-in defaults fill what it leaves out. A profile that is not
 * named, or does not exist, fails CONFIGURATION_ERROR with no fallback.
 */
export function resolveAccess(tool: Tool, globals: GlobalOptions): Access {
  const { provider, store } = tool;
  const config = store.readConfig();
  const profileName = globals.profile ?? config.activeProfile;
  if (profileName === undefined) throw noProfile(provider);
  const profile = selectedProfile(tool, profileName);
  const credential = profileCredential(provider, profileName, profile);
  const { baseUrl, endpoint } = resolveEndpoint(provider, profileName, profile);
  return { profileName, baseUrl, endpoint, ...(credential ? { credential } : {}) };
}

/** Resolves the base URL and endpoint fields from the profile, then the default. A stored base URL wins over a field that derives it. */
function resolveEndpoint(provider: Provider, profileName: string, profile: Profile): { baseUrl: string; endpoint: Record<string, string> } {
  const endpoint: Record<string, string> = {};
  for (const field of endpointFields(provider)) {
    const value = profile[field.key] ?? field.default;
    if (value !== undefined) endpoint[field.key] = value;
  }
  return { baseUrl: resolveBaseUrl(provider, profileName, profile), endpoint };
}

function resolveBaseUrl(provider: Provider, profileName: string, profile: Profile): string {
  const deriving = derivingField(provider);
  if (profile.baseUrl !== undefined) return profile.baseUrl;
  const value = deriving ? profile[deriving.key] : undefined;
  if (deriving && value !== undefined) return derivedBaseUrl(provider, deriving, value);
  if (provider.baseUrl.default !== undefined) return provider.baseUrl.default;
  if (deriving?.default !== undefined) return derivedBaseUrl(provider, deriving, deriving.default);
  const option = deriving ? `--${kebab(deriving.key)} ${fieldExample(deriving)}` : `--base-url ${baseUrlExample(provider)}`;
  throw new CliError("CONFIGURATION_ERROR", `Profile "${profileName}" has no ${provider.name} base URL.`, {
    hint: `Run '${provider.bin} profiles update ${profileName} ${option}'.`,
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

/** The credential a request sends. Fails AUTHENTICATION_REQUIRED when the profile does not store the request's credential. */
export function requireCredential(provider: Provider, access: Access, setName?: string): Credential {
  const credential = credentialFor(provider, access.credential, setName);
  if (credential) return credential;
  const sets = setsFor(provider, setName);
  throw new CliError("AUTHENTICATION_REQUIRED", `Profile "${access.profileName}" has no ${provider.name} ${credentialNoun(provider, sets)}.`, {
    hint: `Run '${provider.bin} profiles update ${access.profileName}' with ${credentialOptionsText(sets)}.`,
  });
}

function noProfile(provider: Provider): CliError {
  return new CliError("CONFIGURATION_ERROR", `No ${provider.name} profile is selected and none is active.`, {
    hint: `Run '${provider.bin} setup NAME' or '${provider.bin} profiles use NAME', or pass --profile NAME.`,
  });
}

function selectedProfile(tool: Tool, name: string): Profile {
  const profile = tool.store.readProfile(name);
  if (profile) return profile;
  const bin = tool.provider.bin;
  throw new CliError("CONFIGURATION_ERROR", `Profile "${name}" does not exist.`, {
    hint: `Run '${bin} setup ${name}' to create it, or '${bin} profiles use NAME' to activate a profile from '${bin} profiles list'.`,
  });
}

function missingText(names: string[]): string {
  return `${names.join(" and ")} ${names.length > 1 ? "are" : "is"} missing`;
}

function profileCredential(provider: Provider, name: string, profile: Profile): Credential | undefined {
  return credentialFrom(provider, profile, (_set: FieldSet, missing: SecretField[]) =>
    new CliError("AUTHENTICATION_REQUIRED", `Profile "${name}" stores an incomplete credential: ${missingText(missing.map((field) => field.key))}.`, {
      hint: `Run '${provider.bin} profiles update ${name}' with ${credentialOptionsText([{ name: "credential", fields: missing }])}.`,
    }),
  );
}
