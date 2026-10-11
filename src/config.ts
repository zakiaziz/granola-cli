import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Profile } from "./types.js";
import { CliError } from "./errors.js";
import { environmentValue, isRecord } from "./util.js";
import { redact, validateBaseUrl } from "./values.js";

export interface AppConfig {
  readonly activeProfile?: string;
  readonly baseUrl?: string;
}

export function configDir(): string {
  let configured = environmentValue("XDG_CONFIG_HOME");
  if (configured && !isAbsolute(configured)) configured = undefined;
  return join(configured ?? join(homedir(), ".config"), "granola");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function profilesDir(): string {
  return join(configDir(), "profiles");
}

export function profilePath(name: string): string {
  assertProfileName(name);
  return join(profilesDir(), `${name}.json`);
}

export function readConfig(): AppConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  const value = readJsonFile(path);
  if (!isRecord(value)) throw new CliError(`Configuration file ${path} must contain a JSON object`, "CONFIGURATION_ERROR", 3);
  assertOnlyKeys(value, ["activeProfile", "baseUrl"], path);
  const activeProfile = optionalString(value.activeProfile, "activeProfile", path);
  const baseUrlValue = optionalString(value.baseUrl, "baseUrl", path);
  return {
    ...(activeProfile ? { activeProfile } : {}),
    ...(baseUrlValue ? { baseUrl: validateStoredBaseUrl(baseUrlValue, path) } : {}),
  };
}

export function writeConfig(config: AppConfig): void {
  writeSecureJson(configPath(), config);
}

export function getActiveProfileName(): string | undefined {
  return readConfig().activeProfile;
}

export function setActiveProfileName(name: string): void {
  assertProfileName(name);
  writeConfig({ ...readConfig(), activeProfile: name });
}

export function listProfiles(): string[] {
  const directory = profilesDir();
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -5))
    .sort();
}

export function readProfile(name: string | undefined): Profile | undefined {
  if (!name) return undefined;
  const path = profilePath(name);
  if (!existsSync(path)) return undefined;
  const value = readJsonFile(path);
  if (!isRecord(value)) throw new CliError(`Profile ${path} must contain a JSON object`, "CONFIGURATION_ERROR", 3);
  assertOnlyKeys(value, ["apiKey", "baseUrl"], path);
  const apiKey = optionalString(value.apiKey, "apiKey", path);
  const baseUrl = optionalString(value.baseUrl, "baseUrl", path);
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl: validateStoredBaseUrl(baseUrl, path) } : {}),
  };
}

export function requireProfile(name: string): Profile {
  const profile = readProfile(name);
  if (!profile) throw new CliError(`Profile "${name}" does not exist`, "NOT_FOUND", 5);
  return profile;
}

export function profileExists(name: string): boolean {
  return existsSync(profilePath(name));
}

export function writeProfile(name: string, profile: Profile): void {
  assertProfileName(name);
  if (!profile.apiKey && !profile.baseUrl) throw new CliError("A profile must contain an API key or base URL");
  writeSecureJson(profilePath(name), {
    ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
    ...(profile.baseUrl ? { baseUrl: validateBaseUrl(profile.baseUrl) } : {}),
  });
}

export function deleteProfile(name: string): void {
  const path = profilePath(name);
  if (!existsSync(path)) throw new CliError(`Profile "${name}" does not exist`, "NOT_FOUND", 5);
  if (getActiveProfileName() === name) {
    throw new CliError(
      `Profile "${name}" is active. Activate another profile or run granola config unset activeProfile first.`, "CONFLICT", 6,
    );
  }
  rmSync(path);
}

export function showProfile(name: string): unknown {
  return redact(requireProfile(name));
}

export function resolveProfileName(explicitProfile: string | undefined): string | undefined {
  return explicitProfile ?? environmentValue("GRANOLA_PROFILE") ?? getActiveProfileName();
}

export function configGet(key: string): unknown {
  if (key !== "activeProfile" && key !== "baseUrl") {
    throw new CliError(`Unknown configuration key "${key}". Use activeProfile or baseUrl.`);
  }
  return readConfig()[key];
}

export function configSet(key: string, value: string): AppConfig {
  const config = readConfig();
  if (key === "activeProfile") {
    assertProfileName(value);
    requireProfile(value);
    const updated = { ...config, activeProfile: value };
    writeConfig(updated);
    return updated;
  }
  if (key === "baseUrl") {
    const updated = { ...config, baseUrl: validateBaseUrl(value) };
    writeConfig(updated);
    return updated;
  }
  throw new CliError(`Unknown configuration key "${key}". Use activeProfile or baseUrl.`);
}

export function configUnset(key: string): AppConfig {
  const config = readConfig();
  if (key === "activeProfile") {
    const { activeProfile: _removed, ...updated } = config;
    writeConfig(updated);
    return updated;
  }
  if (key === "baseUrl") {
    const { baseUrl: _removed, ...updated } = config;
    writeConfig(updated);
    return updated;
  }
  throw new CliError(`Unknown configuration key "${key}". Use activeProfile or baseUrl.`);
}

function writeSecureJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  chmodSync(configDir(), 0o700);
  chmodSync(dirname(path), 0o700);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (existsSync(temporaryPath)) rmSync(temporaryPath);
    throw error;
  }
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(`Cannot read valid JSON configuration from ${path}`, "CONFIGURATION_ERROR", 3);
  }
}

function assertProfileName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new CliError("Profile names may only contain letters, numbers, dots, underscores, and hyphens");
  }
}

function optionalString(value: unknown, key: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new CliError(`${key} in ${path} must be a non-empty string`, "CONFIGURATION_ERROR", 3);
  }
  return value;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new CliError(
      `Unknown field "${unknown}" in ${path}. Allowed fields: ${allowedKeys.join(", ")}.`, "CONFIGURATION_ERROR", 3,
    );
  }
}

function validateStoredBaseUrl(value: string, path: string): string {
  try { return validateBaseUrl(value); } catch { throw new CliError(`Invalid baseUrl in ${path}`, "CONFIGURATION_ERROR", 3); }
}
