import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { endpoints } from "../src/endpoints.js";

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");

describe("README command reference", () => {
  test("documents every registered Granola API command", () => {
    expect(endpoints).toHaveLength(9);
    for (const endpoint of endpoints) {
      const command = endpoint.pattern
        .map((part) => (part.startsWith(":") ? `<${part.slice(1)}>` : part))
        .join(" ");
      expect(readme).toContain(`granola ${command}`);
      expect(endpoint.docs).toStartWith("https://docs.granola.ai/");
    }
  });

  test("documents every built-in command", () => {
    for (const command of [
      "setup",
      "profiles list",
      "profiles show <name>",
      "profiles create <name>",
      "profiles update <name>",
      "profiles delete <name>",
      "profiles use <name>",
      "config path",
      "config show",
      "config get <key>",
      "config set <key> <value>",
      "config unset <key>",
      "auth verify",
    ]) {
      expect(readme).toContain(`granola ${command}`);
    }
  });

  test("uses the project documentation style", () => {
    expect(readme).not.toContain("—");
  });
});
