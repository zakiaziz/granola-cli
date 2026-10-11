import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeContext, requireApiKey, resolveApiKey } from "../src/auth.js";
import { setActiveProfileName, writeConfig, writeProfile } from "../src/config.js";
import type { GlobalOptions } from "../src/types.js";

const defaults: GlobalOptions = {
  format: "json",
  all: false,
  yes: false,
  dryRun: false,
  help: false,
  version: false,
};

describe.serial("authentication", () => {
  let root: string;
  let originalXdg: string | undefined;
  let originalApiKey: string | undefined;
  let originalBaseUrl: string | undefined;

  beforeEach(() => {
    originalXdg = process.env.XDG_CONFIG_HOME;
    originalApiKey = process.env.GRANOLA_API_KEY;
    originalBaseUrl = process.env.GRANOLA_BASE_URL;
    root = mkdtempSync(join(tmpdir(), "granola-auth-test-"));
    process.env.XDG_CONFIG_HOME = root;
    delete process.env.GRANOLA_API_KEY;
    delete process.env.GRANOLA_BASE_URL;
  });

  afterEach(() => {
    restoreEnvironment("XDG_CONFIG_HOME", originalXdg);
    restoreEnvironment("GRANOLA_API_KEY", originalApiKey);
    restoreEnvironment("GRANOLA_BASE_URL", originalBaseUrl);
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  });

  test("loads base URLs through the documented precedence order", () => {
    expect(loadRuntimeContext(defaults)).toEqual({ baseUrl: "https://public-api.granola.ai" });

    writeConfig({ baseUrl: "https://config.example" });
    writeProfile("work", { apiKey: "profile-key", baseUrl: "https://profile.example" });
    setActiveProfileName("work");
    expect(loadRuntimeContext(defaults)).toMatchObject({
      profileName: "work",
      profile: { apiKey: "profile-key", baseUrl: "https://profile.example" },
      baseUrl: "https://profile.example",
    });

    process.env.GRANOLA_BASE_URL = "https://environment.example";
    expect(loadRuntimeContext(defaults).baseUrl).toBe("https://environment.example");
    expect(loadRuntimeContext({ ...defaults, baseUrl: "https://flag.example" }).baseUrl).toBe(
      "https://flag.example",
    );
  });

  test("resolves API keys through flags, environment, profiles, and missing state", () => {
    const profileContext = { profileName: "work", profile: { apiKey: "profile-key" }, baseUrl: "https://example.test" };
    expect(resolveApiKey({ ...defaults, apiKey: "flag-key" }, profileContext)).toEqual({
      token: "flag-key",
      source: "--api-key",
    });
    process.env.GRANOLA_API_KEY = "environment-key";
    expect(resolveApiKey(defaults, profileContext)).toEqual({
      token: "environment-key",
      source: "GRANOLA_API_KEY",
    });
    delete process.env.GRANOLA_API_KEY;
    expect(resolveApiKey(defaults, profileContext)).toEqual({
      token: "profile-key",
      source: "profile:work",
    });
    expect(resolveApiKey(defaults, { baseUrl: "https://example.test" })).toEqual({});
  });

  test("requires both an API key and its source", () => {
    expect(requireApiKey({ token: "key", source: "test" }, "notes list")).toEqual({
      token: "key",
      source: "test",
    });
    expect(() => requireApiKey({}, "notes list")).toThrow('Missing API key for "notes list"');
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
