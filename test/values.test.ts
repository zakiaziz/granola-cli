import { describe, expect, test } from "bun:test";
import {
  parseBooleanValue,
  parseCommaList,
  parsePositiveInteger,
  redact,
  redactWebhookUrl,
  validateBaseUrl,
  validateDate,
  validateId,
  validateWebhookUrl,
} from "../src/values.js";

describe("input values", () => {
  test("redacts nested secrets without changing public values", () => {
    expect(redact({ apiKey: "one", nested: [{ token: "two", name: "safe" }], count: 1 })).toEqual({
      apiKey: "[redacted]",
      nested: [{ token: "[redacted]", name: "safe" }],
      count: 1,
    });
    expect(redact("plain")).toBe("plain");
  });

  test("validates integers and comma-separated lists", () => {
    expect(parsePositiveInteger("30", "--page-size", 30)).toBe(30);
    expect(() => parsePositiveInteger("one", "--page-size")).toThrow("positive integer");
    expect(() => parsePositiveInteger("999999999999999999999", "--page-size")).toThrow("positive integer");
    expect(() => parsePositiveInteger("31", "--page-size", 30)).toThrow("between 1 and 30");
    expect(parseCommaList("personal, public", "--scopes")).toEqual(["personal", "public"]);
    expect(parseCommaList("", "--folder-ids", { allowEmpty: true })).toEqual([]);
    expect(() => parseCommaList("", "--scopes")).toThrow("cannot be empty");
    expect(() => parseCommaList("a,,b", "--events")).toThrow("contains an empty value");
    expect(() => parseCommaList("a,a", "--events")).toThrow("contains a duplicate value");
    expect(() => parseCommaList("a,b", "--events", { maximum: 1 })).toThrow("accepts at most 1 values");
  });

  test("validates booleans, dates, and resource identifiers", () => {
    expect(parseBooleanValue("true", "--enabled")).toBe(true);
    expect(parseBooleanValue("false", "--enabled")).toBe(false);
    expect(() => parseBooleanValue("yes", "--enabled")).toThrow("must be true or false");
    expect(validateDate("2026-08-27T01:02:03.456Z", "--created-after")).toBe(
      "2026-08-27T01:02:03.456Z",
    );
    expect(() => validateDate("yesterday", "--created-after")).toThrow("must use YYYY-MM-DD");
    expect(validateId("not_1d3tmYTlCICgjy", "note")).toBe("not_1d3tmYTlCICgjy");
    expect(validateId("fol_4y6LduVdwSKC27", "folder")).toBe("fol_4y6LduVdwSKC27");
    expect(validateId("whe_2mKr8fQxLp7Ta3", "webhook")).toBe("whe_2mKr8fQxLp7Ta3");
  });

  test("validates API and webhook URLs", () => {
    expect(validateBaseUrl("https://example.com/")).toBe("https://example.com");
    expect(() => validateBaseUrl("not a URL")).toThrow("Invalid base URL");
    expect(() => validateBaseUrl("ftp://example.com")).toThrow("Use HTTP or HTTPS");
    expect(() => validateBaseUrl("https://user@example.com?x=1")).toThrow(
      "cannot include credentials",
    );
    expect(validateWebhookUrl("https://example.com/hook?token=value")).toBe(
      "https://example.com/hook?token=value",
    );
    expect(() => validateWebhookUrl("not a URL")).toThrow("Invalid webhook URL");
    expect(() => validateWebhookUrl("http://example.com")).toThrow("must use HTTPS");
    expect(() => validateWebhookUrl("https://user:pass@example.com")).toThrow("embedded credentials");
    expect(redactWebhookUrl("https://example.com")).toBe("https://example.com");
    expect(redactWebhookUrl("https://example.com/hook?token=value")).toBe(
      "https://example.com/[redacted]",
    );
  });
});
