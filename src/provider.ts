import type { PageInfo, Provider, ProviderErrorDetail } from "./core/provider.js";
import { HTTP_METHODS } from "./core/types.js";
import { isRecord, visibleAsciiConstraint } from "./core/values.js";
import { commands, groups } from "./registry.js";

export const provider: Provider = {
  bin: "granola",
  name: "Granola",
  secrets: [{ key: "apiKey", label: "API key", validate: visibleAsciiConstraint }],
  authScheme: "a bearer token",
  authorize: (credential) => ({ Authorization: `Bearer ${credential.apiKey}` }),
  baseUrl: { default: "https://public-api.granola.ai", allowPath: false },
  requestIdHeader: "x-request-id",
  errorDetail,
  pagination: {
    apply({ query }, page) {
      query.set("page_size", String(page.size));
      if (page.cursor === null) query.delete("cursor");
      else query.set("cursor", page.cursor);
    },
    read: readPage,
  },
  verify: {
    method: "GET",
    path: "/v1/notes",
    query: [["page_size", "1"]],
    effect:
      "Sends GET /v1/notes?page_size=1. Success proves that Granola accepted the API key for that read. It does not prove identity, because Granola has no identity endpoint, or complete permission coverage.",
  },
  api: {
    methods: HTTP_METHODS,
    examples: [
      "granola api request GET /v1/notes --query page_size=5",
      "granola api request PATCH /v1/webhook-endpoints/whe_01HXYZ --file ./patch.json --dry-run",
    ],
  },
  groups,
  commands,
};

function errorDetail(body: unknown): ProviderErrorDetail {
  if (!isRecord(body)) return {};
  const nested = isRecord(body.error) ? body.error.message : body.error;
  const message = [body.message, nested].find((candidate): candidate is string => typeof candidate === "string" && candidate !== "");
  return {
    ...(message ? { message } : {}),
    ...(typeof body.code === "string" ? { code: body.code } : {}),
    ...(typeof body.request_id === "string" ? { requestId: body.request_id } : {}),
  };
}

function readPage(payload: unknown, collectionKey: string | undefined): PageInfo | undefined {
  if (!isRecord(payload)) return undefined;
  const { hasMore, cursor } = payload;
  if (typeof hasMore !== "boolean") return undefined;
  if (cursor !== null && typeof cursor !== "string") return undefined;
  if (hasMore && !cursor) return undefined;
  const extra = Object.entries(payload).filter(([field]) => !["hasMore", "cursor", collectionKey].includes(field));
  return {
    nextCursor: hasMore ? (cursor as string) : null,
    ...(extra.length > 0 ? { provider: Object.fromEntries(extra) } : {}),
  };
}
