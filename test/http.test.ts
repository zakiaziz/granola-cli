import { describe, expect, test } from "bun:test";
import { executeAllPages, executeRequest, renderDryRun } from "../src/http.js";
import type { RequestPlan } from "../src/types.js";

function plan(url: string): RequestPlan {
  return {
    command: "notes list",
    method: "GET",
    url,
    headers: { Accept: "application/json", Authorization: "Bearer grn_secret" },
    auth: { token: "grn_secret", source: "test" },
    pagination: { itemKey: "notes", maxPageSize: 30 },
  };
}

describe("HTTP execution", () => {
  test("follows cursors and honors max-items on page boundaries", async () => {
    const requestedPageSizes: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requestedPageSizes.push(url.searchParams.get("page_size") ?? "");
        if (!url.searchParams.has("cursor")) {
          return Response.json({ notes: [{ id: "one" }, { id: "two" }], hasMore: true, cursor: "next" });
        }
        return Response.json({ notes: [{ id: "three" }], hasMore: true, cursor: "later" });
      },
    });

    try {
      const result = await executeAllPages(plan(server.url.toString()), 3);
      expect(result).toEqual({
        notes: [{ id: "one" }, { id: "two" }, { id: "three" }],
        hasMore: true,
        cursor: "later",
      });
      expect(requestedPageSizes).toEqual(["3", "1"]);
    } finally {
      server.stop(true);
    }
  });

  test("reports rate limits with retry guidance", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json(
          { error: { code: "RATE_LIMITED", message: "Slow down" } },
          { status: 429, statusText: "Too Many Requests", headers: { "Retry-After": "12" } },
        );
      },
    });

    try {
      await expect(executeRequest(plan(server.url.toString()))).rejects.toThrow(
        "Retry after 12 seconds",
      );
    } finally {
      server.stop(true);
    }
  });

  test("redacts bearer tokens from dry runs", () => {
    expect(renderDryRun(plan("https://public-api.granola.ai/v1/notes"))).toEqual({
      method: "GET",
      url: "https://public-api.granola.ai/v1/notes",
      auth: { source: "test" },
      headers: { Accept: "application/json", Authorization: "[redacted]" },
    });
  });

  test("redacts webhook URL paths and queries from dry runs", () => {
    const request: RequestPlan = {
      ...plan("https://public-api.granola.ai/v1/webhook-endpoints"),
      command: "webhooks create",
      method: "POST",
      body: { url: "https://example.com/secret-token?signature=secret", scopes: ["personal"] },
    };
    expect(renderDryRun(request)).toMatchObject({
      body: { url: "https://example.com/[redacted]", scopes: ["personal"] },
    });
  });

  test("handles empty, non-JSON, and malformed JSON responses", async () => {
    const emptyServer = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
    try {
      expect(await executeRequest(plan(emptyServer.url.toString()))).toBeNull();
    } finally {
      emptyServer.stop(true);
    }

    const textServer = Bun.serve({ port: 0, fetch: () => new Response("failure", { status: 500 }) });
    try {
      await expect(executeRequest(plan(textServer.url.toString()))).rejects.toThrow("failure");
    } finally {
      textServer.stop(true);
    }

    const malformedServer = Bun.serve({
      port: 0,
      fetch: () => new Response("{bad", { headers: { "Content-Type": "application/json" } }),
    });
    try {
      await expect(executeRequest(plan(malformedServer.url.toString()))).rejects.toThrow(
        "returned invalid JSON",
      );
    } finally {
      malformedServer.stop(true);
    }
  });

  test("rejects invalid pagination contracts", async () => {
    await expect(executeAllPages({ ...plan("https://example.test"), pagination: undefined } as RequestPlan)).rejects.toThrow(
      "does not support --all",
    );

    for (const payload of [
      { wrong: [], hasMore: false, cursor: null },
      { notes: [], hasMore: "false", cursor: null },
      { notes: [], hasMore: true, cursor: null },
    ]) {
      const server = Bun.serve({ port: 0, fetch: () => Response.json(payload) });
      try {
        await expect(executeAllPages(plan(server.url.toString()))).rejects.toThrow();
      } finally {
        server.stop(true);
      }
    }

    const repeatedServer = Bun.serve({
      port: 0,
      fetch: () => Response.json({ notes: [], hasMore: true, cursor: "same" }),
    });
    try {
      await expect(executeAllPages(plan(repeatedServer.url.toString()))).rejects.toThrow(
        'repeated pagination cursor "same"',
      );
    } finally {
      repeatedServer.stop(true);
    }

    const exhaustedServer = Bun.serve({
      port: 0,
      fetch: () => Response.json({ notes: [], hasMore: true, cursor: "next" }),
    });
    try {
      await expect(executeAllPages(plan(exhaustedServer.url.toString()), 0)).rejects.toThrow(
        "Pagination stopped without a continuation cursor",
      );
    } finally {
      exhaustedServer.stop(true);
    }
  });

  test("combines pages through the final cursor", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const cursor = new URL(request.url).searchParams.get("cursor");
        return cursor
          ? Response.json({ notes: [{ id: "two" }], hasMore: false, cursor: null })
          : Response.json({ notes: [{ id: "one" }], hasMore: true, cursor: "next" });
      },
    });
    try {
      expect(await executeAllPages(plan(server.url.toString()))).toEqual({
        notes: [{ id: "one" }, { id: "two" }],
        hasMore: false,
        cursor: null,
      });
    } finally {
      server.stop(true);
    }
  });

  test("classifies network failures without leaking transport messages", async () => {
    const readPlan = plan("http://127.0.0.1:1/unreachable");
    try {
      await executeRequest(readPlan);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "NETWORK_ERROR", exitCode: 7, retryable: true, details: { outcome_unknown: false } });
      expect((error as Error).message).not.toContain("fetch");
    }
    try {
      await executeRequest({ ...readPlan, method: "POST", body: {} });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toMatchObject({ retryable: false, details: { outcome_unknown: true } });
      expect((error as Error).message).toContain("verify remote state");
    }
  });

  test("classifies unreadable and unsupported response bodies", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("secret fragment")); } }));
    try {
      await expect(executeRequest(plan("https://example.test"))).rejects.toMatchObject({ code: "NETWORK_ERROR", retryable: true });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const server = Bun.serve({ port: 0, fetch: () => new Response("binary", { headers: { "Content-Type": "application/octet-stream" } }) });
    try {
      await expect(executeRequest(plan(server.url.toString()))).rejects.toThrow("unsupported content type");
    } finally {
      server.stop(true);
    }
  });

  test("rejects pages larger than the requested boundary", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ notes: [{}, {}], hasMore: false, cursor: null }) });
    try {
      await expect(executeAllPages({ ...plan(`${server.url}v1/notes?page_size=1`), pagination: { itemKey: "notes", maxPageSize: 30 } })).rejects.toThrow("exceeded requested page size 1");
    } finally {
      server.stop(true);
    }
  });

});
