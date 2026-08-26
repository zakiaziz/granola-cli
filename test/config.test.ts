import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configDir,
  configGet,
  configPath,
  configSet,
  configUnset,
  deleteProfile,
  listProfiles,
  profileExists,
  profilePath,
  profilesDir,
  readConfig,
  readProfile,
  requireProfile,
  resolveProfileName,
  setActiveProfileName,
  showProfile,
  writeConfig,
  writeProfile,
} from "../src/config.js";

describe.serial("configuration", () => {
  let root: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    originalXdg = process.env.XDG_CONFIG_HOME;
    root = mkdtempSync(join(tmpdir(), "granola-config-test-"));
    process.env.XDG_CONFIG_HOME = root;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  });

  test("stores profiles securely and redacts API keys", () => {
    writeProfile("work", { apiKey: "grn_secret", baseUrl: "https://example.test" });
    setActiveProfileName("work");

    expect(configDir()).toBe(join(root, "granola"));
    expect(listProfiles()).toEqual(["work"]);
    expect(readProfile("work")).toEqual({ apiKey: "grn_secret", baseUrl: "https://example.test" });
    expect(showProfile("work")).toEqual({ apiKey: "[redacted]", baseUrl: "https://example.test" });
    expect(statSync(configDir()).mode & 0o777).toBe(0o700);
    expect(statSync(profilePath("work")).mode & 0o777).toBe(0o600);
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  test("requires an absolute XDG configuration path", () => {
    process.env.XDG_CONFIG_HOME = "relative/path";
    expect(() => configDir()).toThrow("XDG_CONFIG_HOME must be an absolute path");
  });

  test("manages profile and global configuration lifecycles explicitly", () => {
    expect(listProfiles()).toEqual([]);
    expect(readProfile(undefined)).toBeUndefined();
    expect(readProfile("missing")).toBeUndefined();
    expect(profileExists("missing")).toBe(false);
    expect(() => requireProfile("missing")).toThrow('Profile "missing" does not exist');
    expect(() => writeProfile("bad/name", { apiKey: "key" })).toThrow("Profile names may only contain");
    expect(() => writeProfile("empty", {})).toThrow("must contain an API key or base URL");

    writeProfile("work", { apiKey: "work-key" });
    writeProfile("other", { apiKey: "other-key" });
    setActiveProfileName("work");
    expect(resolveProfileName(undefined)).toBe("work");
    expect(resolveProfileName("other")).toBe("other");
    expect(configGet("activeProfile")).toBe("work");
    expect(configSet("baseUrl", "https://api.example")).toEqual({
      activeProfile: "work",
      baseUrl: "https://api.example",
    });
    expect(configUnset("baseUrl")).toEqual({ activeProfile: "work" });
    expect(configSet("activeProfile", "other")).toEqual({ activeProfile: "other" });
    expect(() => deleteProfile("other")).toThrow('Profile "other" is active');
    expect(configUnset("activeProfile")).toEqual({});
    deleteProfile("other");
    expect(profileExists("other")).toBe(false);
    expect(() => deleteProfile("missing")).toThrow('Profile "missing" does not exist');
    expect(() => configGet("unknown")).toThrow("Unknown configuration key");
    expect(() => configSet("unknown", "value")).toThrow("Unknown configuration key");
    expect(() => configUnset("unknown")).toThrow("Unknown configuration key");
    expect(() => configSet("activeProfile", "missing")).toThrow('Profile "missing" does not exist');
  });

  test("rejects malformed and unknown configuration fields", () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configPath(), "[]\n");
    expect(() => readConfig()).toThrow("must contain a JSON object");
    writeFileSync(configPath(), '{"baseURL":"https://example.com"}\n');
    expect(() => readConfig()).toThrow('Unknown field "baseURL"');
    writeFileSync(configPath(), '{"baseUrl":42}\n');
    expect(() => readConfig()).toThrow("baseUrl");
    writeFileSync(configPath(), "not-json\n");
    expect(() => readConfig()).toThrow(`Cannot read ${configPath()}`);

    mkdirSync(profilesDir(), { recursive: true });
    writeFileSync(profilePath("bad"), '{"api_key":"secret"}\n');
    expect(() => readProfile("bad")).toThrow('Unknown field "api_key"');
    writeFileSync(profilePath("bad"), '"profile"\n');
    expect(() => readProfile("bad")).toThrow("must contain a JSON object");
    writeFileSync(profilePath("bad"), '{"apiKey":""}\n');
    expect(() => readProfile("bad")).toThrow("apiKey");
  });

  test("removes temporary files when an atomic configuration rename fails", () => {
    mkdirSync(configPath(), { recursive: true });
    expect(() => writeConfig({ baseUrl: "https://example.com" })).toThrow();
    expect(readdirSync(configDir())).toEqual(["config.json"]);
  });
});
