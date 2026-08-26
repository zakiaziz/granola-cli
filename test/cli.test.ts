import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
let configHome: string;

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "granola-cli-e2e-"));
});

afterEach(() => {
  chmodSync(configHome, 0o700);
  rmSync(configHome, { recursive: true, force: true });
});

describe("granola CLI", () => {
  test("prints help and version without authentication", async () => {
    const help = await runCli(["--help"]);
    const version = await runCli(["--version"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("granola note transcript <note-id>");
    expect(help.stdout).toContain("granola webhooks create");
    expect(version.stdout.trim()).toBe("0.1.0");
    const typo = await runCli(["--help", "--hepl"]);
    expect(typo.exitCode).toBe(1);
    expect(typo.stderr).toContain("Unknown option --hepl");
  });

  test("sets up profiles from the environment and redacts API keys", async () => {
    const setup = await runCli(["setup", "work", "--from-env"], { GRANOLA_API_KEY: "grn_environment" });
    expect(setup.exitCode).toBe(0);
    expect(JSON.parse(setup.stdout)).toMatchObject({ profile: "work", active: true });

    const shown = await runCli(["profiles", "show", "work"]);
    expect(JSON.parse(shown.stdout)).toEqual({ apiKey: "[redacted]" });
  });

  test("manages profiles without overwriting or deleting the active profile", async () => {
    expect((await runCli(["profiles", "create", "work", "--api-key", "work-key"])).exitCode).toBe(0);
    const duplicate = await runCli(["profiles", "create", "work", "--api-key", "replacement"]);
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stderr).toContain('Profile "work" already exists');
    expect((await runCli(["profiles", "create", "other", "--api-key", "other-key"])).exitCode).toBe(0);
    expect((await runCli(["profiles", "use", "work"])).exitCode).toBe(0);
    const blocked = await runCli(["profiles", "delete", "work"]);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain('Profile "work" is active');
    expect((await runCli(["config", "unset", "activeProfile"])).exitCode).toBe(0);
    expect((await runCli(["profiles", "delete", "work"])).exitCode).toBe(0);
    expect(JSON.parse((await runCli(["profiles", "list"])).stdout)).toEqual({
      active: null,
      profiles: ["other"],
    });
  });

  test("requires confirmation and redacts webhook dry runs", async () => {
    const args = [
      "webhooks",
      "create",
      "--url",
      "https://example.com/granola?token=secret",
      "--scopes",
      "personal",
      "--api-key",
      "grn_secret",
    ];
    const blocked = await runCli(args);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain('"webhooks create" changes Granola state');

    const dryRun = await runCli([...args, "--dry-run"]);
    expect(dryRun.exitCode).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      method: "POST",
      auth: { source: "--api-key" },
      headers: { Authorization: "[redacted]" },
      body: { url: "https://example.com/[redacted]", scopes: ["personal"] },
    });
    expect(dryRun.stdout).not.toContain("grn_secret");
    expect(dryRun.stdout).not.toContain("token=secret");
  });

  test("verifies authentication through a bounded notes request", async () => {
    let authorization = "";
    let pageSize = "";
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        authorization = request.headers.get("authorization") ?? "";
        pageSize = new URL(request.url).searchParams.get("page_size") ?? "";
        return Response.json({ notes: [{ id: "not_1d3tmYTlCICgjy" }], hasMore: false, cursor: null });
      },
    });

    try {
      const result = await runCli([
        "auth",
        "verify",
        "--api-key",
        "grn_secret",
        "--base-url",
        server.url.toString(),
      ]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ authenticated: true, notes_returned: 1 });
      expect(authorization).toBe("Bearer grn_secret");
      expect(pageSize).toBe("1");
    } finally {
      server.stop(true);
    }
  });

  test("prints API JSON without transformation by default", async () => {
    const payload = { notes: [{ id: "not_1d3tmYTlCICgjy", title: "Review" }], hasMore: false, cursor: null };
    const server = Bun.serve({ port: 0, fetch: () => Response.json(payload) });
    try {
      const result = await runCli([
        "notes",
        "list",
        "--api-key",
        "grn_secret",
        "--base-url",
        server.url.toString(),
      ]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(payload);
    } finally {
      server.stop(true);
    }
  });

  test("returns the one-time webhook signing secret only after confirmation", async () => {
    let requestBody: unknown;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestBody = await request.json();
        return Response.json(
          {
            id: "whe_2mKr8fQxLp7Ta3",
            object: "webhook_endpoint",
            signing_secret: "whsec_one_time",
          },
          { status: 201 },
        );
      },
    });
    try {
      const result = await runCli([
        "webhooks",
        "create",
        "--url",
        "https://example.com/hook",
        "--scopes",
        "personal",
        "--api-key",
        "grn_secret",
        "--base-url",
        server.url.toString(),
        "--yes",
      ]);
      expect(result.exitCode).toBe(0);
      expect(requestBody).toEqual({ url: "https://example.com/hook", scopes: ["personal"] });
      expect(JSON.parse(result.stdout).signing_secret).toBe("whsec_one_time");
    } finally {
      server.stop(true);
    }
  });
});

async function runCli(
  args: readonly string[],
  environment: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const processHandle = Bun.spawn([process.execPath, cli, ...args], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      GRANOLA_API_KEY: "",
      GRANOLA_BASE_URL: "",
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  return { exitCode, stdout, stderr };
}
