import { describe, expect, test } from "bun:test";
import { getGlobalOptions, parseArgs } from "../src/args.js";

describe("argument parsing", () => {
  test("parses commands, aliases, values, and explicit booleans", () => {
    const parsed = parseArgs([
      "notes",
      "list",
      "--format=markdown",
      "--max-items",
      "100",
      "--all=true",
      "-y=false",
    ]);

    expect(parsed.command).toEqual(["notes", "list"]);
    expect(parsed.flags).toEqual({
      format: "markdown",
      "max-items": "100",
      all: true,
      yes: false,
    });
    expect(getGlobalOptions(parsed)).toMatchObject({
      format: "markdown",
      maxItems: 100,
      all: true,
      yes: false,
    });
  });

  test("keeps unknown options for command-specific errors", () => {
    expect(parseArgs(["notes", "list", "--created-aftr", "2026-08-01"]).unknownFlags).toEqual([
      { name: "created-aftr", value: "2026-08-01" },
    ]);
  });

  test("stops option parsing at the argument separator", () => {
    expect(parseArgs(["notes", "list", "--", "--literal", "value"]).command).toEqual([
      "notes",
      "list",
      "--literal",
      "value",
    ]);
  });

  test("rejects missing values, ambiguous booleans, formats, and limits", () => {
    expect(() => parseArgs(["notes", "list", "--page-size"])).toThrow("Missing value for --page-size");
    expect(() => parseArgs(["notes", "list", "--cursor="])).toThrow("--cursor cannot be empty");
    expect(() => parseArgs(["notes", "list", "--all=maybe"])).toThrow(
      'Invalid boolean value "maybe" for --all',
    );
    expect(() => getGlobalOptions(parseArgs(["--format", "yaml"]))).toThrow(
      'Invalid --format "yaml"',
    );
    expect(() => getGlobalOptions(parseArgs(["--max-items", "0"]))).toThrow(
      "--max-items must be a positive integer",
    );
    expect(() => parseArgs(["notes", "list", "--page-size", "10", "--page-size", "20"])).toThrow(
      "Option --page-size may only be provided once",
    );
  });
});
