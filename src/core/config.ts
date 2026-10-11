// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { CliError } from "./errors.js";
import { endpointFields, fieldConstraint } from "./fields.js";
import type { EndpointField, Provider } from "./provider.js";
import { baseUrlConstraint, echoable, invalidValue, invalidVariable, isRecord, redactCredentials } from "./values.js";

/** Stored credential fields, baseUrl, and endpoint fields, by key. */
export type Profile = Record<string, string>;

/** config.json: activeProfile, baseUrl, and endpoint fields, by key. */
export type AppConfig = Record<string, string>;

/** Every config key of a provider, in output order: activeProfile, baseUrl, then its endpoint fields. */
export function configKeys(provider: Provider): string[] {
  return ["activeProfile", "baseUrl", ...endpointFields(provider).map((field) => field.key)];
}

/** Keys changed through config set and unset: every config key except activeProfile. */
export function writableConfigKeys(provider: Provider): string[] {
  return configKeys(provider).filter((key) => key !== "activeProfile");
}

export const PROFILE_NAME_PATTERN = "^[A-Za-z0-9._-]+$";
const PROFILE_NAME_CONSTRAINT = `match ${PROFILE_NAME_PATTERN} and not be "." or ".."`;
const PROFILE_NAME_HINT = "Use letters, numbers, dots, underscores, and hyphens.";
const PROFILE_FILE = /^[A-Za-z0-9._-]+\.json$/;

export function isValidProfileName(name: string): boolean {
  return name !== "." && name !== ".." && new RegExp(PROFILE_NAME_PATTERN).test(name);
}

export function checkProfileName(subject: string, name: string): string {
  if (isValidProfileName(name)) return name;
  throw invalidValue(subject, PROFILE_NAME_CONSTRAINT, name, PROFILE_NAME_HINT, PROFILE_NAME_PATTERN);
}

export function checkProfileVariable(variable: string, name: string): string {
  if (isValidProfileName(name)) return name;
  throw invalidVariable(variable, PROFILE_NAME_CONSTRAINT, name, PROFILE_NAME_HINT, PROFILE_NAME_PATTERN);
}

export class ConfigStore {
  private readonly profileKeys: readonly string[];
  private readonly configKeys: readonly string[];

  constructor(private readonly provider: Provider) {
    this.profileKeys = [...provider.secrets.map((field) => field.key), "baseUrl", ...endpointFields(provider).map((field) => field.key)];
    this.configKeys = configKeys(provider);
  }

  dir(): string {
    const configured = process.env.XDG_CONFIG_HOME;
    const root = configured && isAbsolute(configured) ? configured : join(homedir(), ".config");
    return join(root, this.provider.bin);
  }

  configPath(): string {
    return join(this.dir(), "config.json");
  }

  profilePath(name: string): string {
    return join(this.profilesDir(), `${name}.json`);
  }

  readConfig(): AppConfig {
    const path = this.configPath();
    if (!existsSync(path)) return {};
    const value = this.readJsonFile(path);
    this.assertOnlyKeys(value, this.configKeys, path);
    const activeProfile = this.storedString(value, "activeProfile", path);
    if (activeProfile !== undefined && !isValidProfileName(activeProfile)) {
      throw this.fileError(`activeProfile in ${path} must ${PROFILE_NAME_CONSTRAINT}; received "${echoable(activeProfile)}".`);
    }
    const config: AppConfig = {};
    if (activeProfile !== undefined) config.activeProfile = activeProfile;
    this.readSettings(value, path, config);
    return config;
  }

  writeConfig(config: AppConfig): void {
    const ordered = Object.fromEntries(this.configKeys.filter((key) => config[key] !== undefined).map((key) => [key, config[key]]));
    this.writeSecureJson(this.configPath(), ordered);
  }

  listProfileNames(): string[] {
    const directory = this.profilesDir();
    if (!existsSync(directory)) return [];
    let files: string[];
    try {
      files = readdirSync(directory);
    } catch (error) {
      throw this.fileFailure(directory, "read", error);
    }
    return files
      .filter((file) => PROFILE_FILE.test(file))
      .map((file) => file.slice(0, -".json".length))
      .filter(isValidProfileName)
      .sort();
  }

  readProfile(name: string): Profile | undefined {
    const path = this.profilePath(name);
    if (!existsSync(path)) return undefined;
    const value = this.readJsonFile(path);
    this.assertOnlyKeys(value, this.profileKeys, path);
    const profile: Profile = {};
    for (const field of this.provider.secrets) {
      const stored = this.storedString(value, field.key, path);
      if (stored === undefined) continue;
      const constraint = field.validate(stored);
      if (constraint) throw this.fileError(`${field.key} in ${path} must ${constraint}.`);
      profile[field.key] = stored;
    }
    this.readSettings(value, path, profile);
    return profile;
  }

  writeProfile(name: string, profile: Profile): void {
    const ordered = Object.fromEntries(
      this.profileKeys.filter((key) => profile[key] !== undefined).map((key) => [key, profile[key]]),
    );
    this.writeSecureJson(this.profilePath(name), ordered);
  }

  deleteProfile(name: string): void {
    const path = this.profilePath(name);
    try {
      rmSync(path);
    } catch (error) {
      throw this.fileFailure(path, "deleted", error);
    }
  }

  private profilesDir(): string {
    return join(this.dir(), "profiles");
  }

  private writeSecureJson(path: string, value: unknown): void {
    const temporaryPath = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      for (const directory of [this.dir(), this.profilesDir(), dirname(path)]) {
        if (existsSync(directory)) chmodSync(directory, 0o700);
      }
      writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, path);
      chmodSync(path, 0o600);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw this.fileFailure(path, "written", error);
    }
  }

  private fileFailure(path: string, action: string, error: unknown): CliError {
    const code = (error as { code?: unknown }).code;
    return this.fileError(`${path} could not be ${action}${typeof code === "string" ? ` (${code})` : ""}.`);
  }

  private readJsonFile(path: string): Record<string, unknown> {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw this.fileError(`${path} is not readable JSON.`);
    }
    if (!isRecord(value)) throw this.fileError(`${path} must contain a JSON object.`);
    return value;
  }

  private assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) throw this.fileError(`${path} has unknown key "${unknown}". Allowed keys: ${allowed.join(", ")}.`);
  }

  private storedString(value: Record<string, unknown>, key: string, path: string): string | undefined {
    const item = value[key];
    if (item === undefined) return undefined;
    if (typeof item === "string" && item !== "") return item;
    throw this.fileError(`${key} in ${path} must be a nonempty string.`);
  }

  /** Reads baseUrl and the endpoint fields into target, validating each. */
  private readSettings(value: Record<string, unknown>, path: string, target: Record<string, string>): void {
    const baseUrl = this.storedString(value, "baseUrl", path);
    if (baseUrl !== undefined) {
      const constraint = baseUrlConstraint(baseUrl, this.provider.baseUrl.allowPath);
      if (constraint) throw this.fileError(`baseUrl in ${path} must ${constraint}; received "${echoable(redactCredentials(baseUrl))}".`);
      target.baseUrl = baseUrl;
    }
    for (const field of endpointFields(this.provider)) {
      const stored = this.storedString(value, field.key, path);
      if (stored === undefined) continue;
      target[field.key] = this.checkedField(field, stored, path);
    }
  }

  private checkedField(field: EndpointField, stored: string, path: string): string {
    const constraint = fieldConstraint(field, stored);
    if (!constraint) return stored;
    throw this.fileError(`${field.key} in ${path} must ${constraint}; received "${echoable(stored)}".`);
  }

  private fileError(message: string): CliError {
    return new CliError("CONFIGURATION_ERROR", message, {
      hint: `Fix or delete the file, or run '${this.provider.bin} setup'.`,
    });
  }
}
