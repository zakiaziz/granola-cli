import { describe, expect, test } from "bun:test";
import { getGlobalOptions, parseArgs } from "../src/args.js";
import { buildGranolaOperation } from "../src/commands.js";

const context = { baseUrl: "https://public-api.granola.ai" };

function operation(argv: string[]) {
  const parsed = parseArgs([...argv, "--api-key", "grn_test"]);
  return buildGranolaOperation(parsed, getGlobalOptions(parsed), context);
}

describe("Granola commands", () => {
  test("builds documented note filters", () => {
    const result = operation([
      "notes",
      "list",
      "--created-after",
      "2026-08-01",
      "--folder-id",
      "fol_4y6LduVdwSKC27",
      "--page-size",
      "30",
    ]);
    const url = new URL(result.plan.url);

    expect(result.resource).toBe("notes");
    expect(url.pathname).toBe("/v1/notes");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      created_after: "2026-08-01",
      folder_id: "fol_4y6LduVdwSKC27",
      page_size: "30",
    });
  });

  test("builds a Granola webhook create body", () => {
    const result = operation([
      "webhooks",
      "create",
      "--url",
      "https://example.com/granola",
      "--scopes",
      "personal,public",
      "--events",
      "note.generated,note.edited",
      "--folder-ids",
      "fol_4y6LduVdwSKC27",
      "--dry-run",
    ]);

    expect(result.mutation).toBe(true);
    expect(result.plan.body).toEqual({
      url: "https://example.com/granola",
      scopes: ["personal", "public"],
      events: ["note.generated", "note.edited"],
      folder_ids: ["fol_4y6LduVdwSKC27"],
    });
  });

  test("supports clearing a webhook folder filter", () => {
    const result = operation([
      "webhooks",
      "update",
      "whe_2mKr8fQxLp7Ta3",
      "--folder-ids=",
      "--dry-run",
    ]);
    expect(result.plan.body).toEqual({ folder_ids: [] });
  });

  test("builds note, transcript, audit, and webhook update requests", () => {
    const note = operation(["note", "show", "not_1d3tmYTlCICgjy", "--include", "transcript"]);
    expect(new URL(note.plan.url).searchParams.get("include")).toBe("transcript");

    const transcript = operation([
      "note",
      "transcript",
      "not_1d3tmYTlCICgjy",
      "--cursor",
      "next",
      "--page-size",
      "100",
      "--all",
    ]);
    expect(new URL(transcript.plan.url).pathname).toBe("/v1/notes/not_1d3tmYTlCICgjy/transcript");
    expect(transcript.plan.pagination).toEqual({ itemKey: "transcript", maxPageSize: 100 });

    const audit = operation([
      "audit",
      "list",
      "--action",
      "workspace.member_added",
      "--occurred-before",
      "2026-08-27T01:02:03Z",
      "--occurred-after",
      "2026-08-01",
    ]);
    expect(Object.fromEntries(new URL(audit.plan.url).searchParams)).toEqual({
      action: "workspace.member_added",
      occurred_before: "2026-08-27T01:02:03Z",
      occurred_after: "2026-08-01",
    });

    const webhook = operation([
      "webhooks",
      "update",
      "whe_2mKr8fQxLp7Ta3",
      "--url",
      "https://example.com/hook",
      "--scopes",
      "workspace",
      "--events",
      "note.access_granted",
      "--folder-ids",
      "fol_4y6LduVdwSKC27",
      "--enabled",
      "false",
      "--dry-run",
    ]);
    expect(webhook.plan.body).toEqual({
      url: "https://example.com/hook",
      scopes: ["workspace"],
      events: ["note.access_granted"],
      folder_ids: ["fol_4y6LduVdwSKC27"],
      enabled: false,
    });
  });

  test("rejects invalid and ambiguous inputs before requests", () => {
    expect(() => operation(["unknown", "command"])).toThrow('Unknown command "unknown command"');
    expect(() => operation(["notes", "list", "--typo", "value"])).toThrow("Unknown option --typo");
    expect(() => operation(["note", "show", "bad-id"])).toThrow("Invalid note ID");
    expect(() => operation(["note", "show", "not_1d3tmYTlCICgjy", "--include", "summary"])).toThrow(
      'Invalid --include "summary"',
    );
    expect(() => operation(["notes", "list", "--page-size", "31"])).toThrow(
      "--page-size must be between 1 and 30",
    );
    expect(() => operation(["notes", "list", "--created-after", "2026-02-31"])).toThrow(
      "--created-after is not a valid date",
    );
    expect(() => operation(["notes", "list", "--max-items", "10"])).toThrow(
      "--max-items requires --all",
    );
    expect(() => operation(["webhooks", "list", "--all"])).toThrow(
      '--all is not valid for "webhooks list"',
    );
    expect(() => operation([
      "webhooks",
      "create",
      "--url",
      "https://example.com",
      "--scopes",
      "personal",
      "--dry-run",
      "--format",
      "text",
    ])).toThrow("--dry-run only supports --format json");
    expect(() => operation(["audit", "list", "--action", "Workspace"])).toThrow(
      "--action must start with a lowercase letter",
    );
    expect(() => operation(["webhooks", "create", "--url", "http://example.com", "--scopes", "personal"])).toThrow(
      "--url must use HTTPS",
    );
    expect(() => operation(["webhooks", "create", "--scopes", "personal"])).toThrow(
      "webhooks create needs --url",
    );
    expect(() => operation(["webhooks", "create", "--url", "https://example.com"])).toThrow(
      "webhooks create needs --scopes",
    );
    expect(() => operation(["webhooks", "create", "--url", "https://example.com", "--scopes", "workspace,public"])).toThrow(
      "workspace scope cannot be combined",
    );
    expect(() => operation(["webhooks", "create", "--url", "https://example.com", "--scopes", "private"])).toThrow(
      'Invalid webhook scope "private"',
    );
    expect(() => operation([
      "webhooks",
      "create",
      "--url",
      "https://example.com",
      "--scopes",
      "personal",
      "--events",
      "note.deleted",
    ])).toThrow('Invalid webhook event "note.deleted"');
    expect(() => operation(["webhooks", "update", "whe_2mKr8fQxLp7Ta3"])).toThrow(
      "webhooks update needs at least one",
    );
    expect(() => operation([
      "webhooks",
      "update",
      "whe_2mKr8fQxLp7Ta3",
      "--enabled",
      "yes",
    ])).toThrow("--enabled must be true or false");
    expect(() => operation(["folders", "list", "--created-after", "2026-08-01"])).toThrow(
      '--created-after is not valid for "folders list"',
    );
  });
});
