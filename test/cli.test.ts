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
    expect(help.stdout).toContain("granola notes transcript get <note-id>");
    expect(help.stdout).toContain("granola webhooks create");
    expect(version.stdout.trim()).toBe("granola 0.1.0");
    const typo = await runCli(["--help", "--hepl"]);
    expect(typo.exitCode).toBe(2);
    expect(typo.stderr).toContain("Unknown option --hepl");
  });

  test("sets up profiles from the environment and redacts API keys", async () => {
    const setup = await runCli(["setup", "work", "--from-env"], { GRANOLA_API_KEY: "grn_environment" });
    expect(setup.exitCode).toBe(0);
    expect(JSON.parse(setup.stdout).data).toMatchObject({ profile: "work", active: true });

    const shown = await runCli(["profiles", "get", "work"]);
    expect(JSON.parse(shown.stdout).data).toEqual({ apiKey: "[redacted]" });
  });

  test("manages profiles without overwriting or deleting the active profile", async () => {
    expect((await runCli(["profiles", "create", "work", "--api-key", "work-key"])).exitCode).toBe(0);
    const duplicate = await runCli(["profiles", "create", "work", "--api-key", "replacement"]);
    expect(duplicate.exitCode).toBe(6);
    expect(JSON.parse(duplicate.stderr).error.message).toContain('Profile "work" already exists');
    expect((await runCli(["profiles", "create", "other", "--api-key", "other-key"])).exitCode).toBe(0);
    expect((await runCli(["profiles", "use", "work"])).exitCode).toBe(0);
    const blocked = await runCli(["profiles", "delete", "work"]);
    expect(blocked.exitCode).toBe(6);
    expect(JSON.parse(blocked.stderr).error.message).toContain('Profile "work" is active');
    expect((await runCli(["config", "unset", "activeProfile"])).exitCode).toBe(0);
    expect((await runCli(["profiles", "delete", "work"])).exitCode).toBe(0);
    expect(JSON.parse((await runCli(["profiles", "list"])).stdout).data).toEqual(["other"]);
  });

  test("classifies setup and selected-profile failures", async () => {
    const missingKey = await runCli(["setup", "work", "--no-input"]);
    expect(missingKey.exitCode).toBe(3);
    expect(JSON.parse(missingKey.stderr).error.code).toBe("CONFIGURATION_ERROR");

    const missingProfile = await runCli(["notes", "list", "--profile", "missing"]);
    expect(missingProfile.exitCode).toBe(3);
    expect(JSON.parse(missingProfile.stderr).error.message).toContain("Selected profile");

    expect((await runCli(["setup", "work", "--api-key", "first"])).exitCode).toBe(0);
    expect((await runCli(["setup", "work", "--api-key", "second"])).exitCode).toBe(6);
    expect((await runCli(["profiles", "get", "missing"])).exitCode).toBe(5);
  });

  test("requires confirmation and redacts webhook dry runs", async () => {
    const args = [
      "webhooks",
      "create",
      "--url",
      "https://example.com/granola?token=secret",
      "--scope",
      "personal",
      "--api-key",
      "grn_secret",
    ];
    const blocked = await runCli(args);
    expect(blocked.exitCode).toBe(9);
    expect(JSON.parse(blocked.stderr).error.message).toContain('"webhooks create" changes Granola state');

    const dryRun = await runCli([...args, "--dry-run"]);
    expect(dryRun.exitCode).toBe(0);
    expect(JSON.parse(dryRun.stdout).data).toMatchObject({
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
      expect(JSON.parse(result.stdout).data).toMatchObject({ authenticated: true, notes_returned: 1 });
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
      expect(JSON.parse(result.stdout)).toEqual({ data: payload.notes, meta: { next_cursor: null, has_more: false } });
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
        "--scope",
        "personal",
        "--api-key",
        "grn_secret",
        "--base-url",
        server.url.toString(),
        "--yes",
      ]);
      expect(result.exitCode).toBe(0);
      expect(requestBody).toEqual({ url: "https://example.com/hook", scopes: ["personal"] });
      expect(JSON.parse(result.stdout).data.signing_secret).toBe("whsec_one_time");
    } finally {
      server.stop(true);
    }
  });

  test("classifies null resources and colors explicit human output", async () => {
    const nullServer = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
    try {
      const missing = await runCli(["notes", "get", "not_missing", "--api-key", "key", "--base-url", nullServer.url.toString()]);
      expect(missing.exitCode).toBe(5);
      const invalidCollection = await runCli(["notes", "list", "--api-key", "key", "--base-url", nullServer.url.toString()]);
      expect(invalidCollection.exitCode).toBe(1);
    } finally {
      nullServer.stop(true);
    }

    const server = Bun.serve({ port: 0, fetch: () => Response.json({ notes: [{ id: "one", title: "One" }], hasMore: false, cursor: null }) });
    try {
      const colored = await runCli(["notes", "list", "--api-key", "key", "--base-url", server.url.toString(), "--format", "human", "--color", "always"]);
      expect(colored.exitCode).toBe(0);
      expect(colored.stdout).toContain("\u001b[38;2;63;185;80m");
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
