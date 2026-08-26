import { describe, expect, test } from "bun:test";
import { formatResult } from "../src/format.js";

describe("output formatting", () => {
  test("keeps JSON as the lossless default", () => {
    expect(formatResult("notes", { notes: [{ id: "not_1" }], hasMore: false, cursor: null }, "json")).toBe(
      '{\n  "notes": [\n    {\n      "id": "not_1"\n    }\n  ],\n  "hasMore": false,\n  "cursor": null\n}\n',
    );
  });

  test("renders transcript text for humans", () => {
    const value = {
      transcript: [
        {
          speaker: { name: "Zaki Aziz", source: "microphone" },
          text: "Ship it.",
          start_time: "2026-08-27T01:00:00Z",
        },
      ],
    };
    expect(formatResult("transcript", value, "text")).toBe(
      "[2026-08-27T01:00:00Z] Zaki Aziz: Ship it.\n",
    );
    expect(formatResult("transcript", value, "markdown")).toContain("**Zaki Aziz**");
  });

  test("renders note collections as Markdown tables", () => {
    const output = formatResult(
      "notes",
      {
        notes: [
          {
            id: "not_1d3tmYTlCICgjy",
            title: "Review",
            owner: { email: "zaki@example.com" },
            created_at: "2026-08-27T01:00:00Z",
            updated_at: "2026-08-27T02:00:00Z",
          },
        ],
      },
      "markdown",
    );
    expect(output).toContain("| ID | Title | Owner | Created | Updated |");
    expect(output).toContain("not_1d3tmYTlCICgjy");
  });

  test("renders full notes in text and Markdown", () => {
    const note = {
      id: "not_1d3tmYTlCICgjy",
      title: "Review | planning",
      owner: { name: "Zaki Aziz", email: "zaki@example.com" },
      created_at: "2026-08-27T01:00:00Z",
      updated_at: "2026-08-27T02:00:00Z",
      web_url: "https://notes.granola.ai/d/example",
      summary_text: "Plain summary",
      summary_markdown: "**Markdown summary**",
      transcript: [{ speaker: { attribution: "me" }, text: "Line *one*" }, "raw line"],
    };
    const text = formatResult("note", note, "text");
    expect(text).toContain("Owner: Zaki Aziz <zaki@example.com>");
    expect(text).toContain("Summary\nPlain summary");
    expect(text).toContain("me: Line *one*");

    const markdown = formatResult("note", note, "markdown");
    expect(markdown).toContain("# Review \\| planning");
    expect(markdown).toContain("## Summary\n\n**Markdown summary**");
    expect(markdown).toContain("## Transcript");
    expect(formatResult("note", "unavailable", "text")).toBe("unavailable\n");
  });

  test("renders every collection and webhook presentation", () => {
    expect(
      formatResult(
        "folders",
        { folders: [{ id: "fol_1", name: "Sales\nCalls", parent_folder_id: null }] },
        "text",
      ),
    ).toContain("Parent folder ID");
    expect(
      formatResult(
        "audit",
        { events: [{ id: "aud_1", action: "workspace.member_added", occurred_at: "now", actor: { object: "system" } }] },
        "markdown",
      ),
    ).toContain("workspace.member_added");
    expect(
      formatResult(
        "webhooks",
        {
          webhook_endpoints: [
            { id: "whe_1", enabled: true, url: "https://example.com", scopes: ["personal"], events: ["note.generated"] },
          ],
        },
        "text",
      ),
    ).toContain("note.generated");
    expect(
      formatResult(
        "webhook",
        { id: "whe_1", enabled: true, scopes: ["personal"], created_by: { email: "zaki@example.com" } },
        "markdown",
      ),
    ).toContain("| created_by | {\"email\":\"zaki@example.com\"} |");
    expect(formatResult("webhook", { id: "whe_1", enabled: true }, "text")).toContain(
      "enabled\ttrue",
    );
    expect(formatResult("webhook", "deleted", "text")).toBe("deleted\n");
    expect(formatResult("folders", { folders: [] }, "markdown")).toBe("_No results._\n");
    expect(formatResult("folders", { folders: [] }, "text")).toBe("No results.\n");
    expect(formatResult("folders", null, "text")).toBe("\n");
  });

  test("handles incomplete transcript presentation data", () => {
    expect(formatResult("transcript", null, "text")).toBe("\n");
    expect(
      formatResult(
        "transcript",
        { transcript: [{ speaker: null, text: { raw: true } }, { speaker: { diarization_label: "Speaker A" }, text: "Hi" }] },
        "markdown",
      ),
    ).toContain('**Unknown**: \\{"raw":true\\}');
  });
});
