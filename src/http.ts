import { requireApiKey, resolveApiKey, type RuntimeContext } from "./auth.js";
import type { Endpoint, GlobalOptions, RequestPlan } from "./types.js";
import { assertRecord, isRecord } from "./util.js";
import { redact, redactWebhookUrl } from "./values.js";

export function buildRequestPlan(input: {
  readonly endpoint: Endpoint;
  readonly params: Record<string, string>;
  readonly query: Record<string, string>;
  readonly body?: unknown;
  readonly options: GlobalOptions;
  readonly context: RuntimeContext;
}): RequestPlan {
  const auth = requireApiKey(resolveApiKey(input.options, input.context), input.endpoint.name);
  const path = fillPath(input.endpoint.path, input.params);
  const url = new URL(path, `${input.context.baseUrl}/`);
  for (const [key, value] of Object.entries(input.query)) url.searchParams.set(key, value);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${auth.token}`,
  };
  if (input.body !== undefined) headers["Content-Type"] = "application/json";

  return {
    command: input.endpoint.name,
    method: input.endpoint.method,
    url: url.toString(),
    headers,
    auth,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.endpoint.pagination ? { pagination: input.endpoint.pagination } : {}),
  };
}

export async function executeRequest(plan: RequestPlan): Promise<unknown> {
  const response = await fetch(plan.url, {
    method: plan.method,
    headers: plan.headers,
    ...(plan.body === undefined ? {} : { body: JSON.stringify(plan.body) }),
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  let payload: unknown = text;
  if (text && contentType.includes("application/json")) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Granola API returned invalid JSON with status ${response.status}`);
    }
  }

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const retryMessage = response.status === 429 && retryAfter ? ` Retry after ${retryAfter} seconds.` : "";
    throw new Error(
      `Granola API returned ${response.status} ${response.statusText}.${retryMessage} ${formatPayload(payload)}`.trim(),
    );
  }
  return text === "" ? null : payload;
}

export async function executeAllPages(plan: RequestPlan, maxItems?: number): Promise<unknown> {
  if (!plan.pagination) throw new Error(`"${plan.command}" does not support --all`);
  const url = new URL(plan.url);
  const configuredPageSize = url.searchParams.get("page_size");
  const pageSize = configuredPageSize ? Number(configuredPageSize) : plan.pagination.maxPageSize;
  const items: unknown[] = [];
  const seenCursors = new Set<string>();

  while (true) {
    if (maxItems !== undefined) {
      const remaining = maxItems - items.length;
      if (remaining <= 0) throw new Error("Pagination stopped without a continuation cursor");
      url.searchParams.set("page_size", String(Math.min(pageSize, remaining)));
    }

    const payload = await executeRequest({ ...plan, url: url.toString() });
    assertRecord(payload, `Response for "${plan.command}"`);
    const pageItems = payload[plan.pagination.itemKey];
    if (!Array.isArray(pageItems)) {
      throw new Error(`Response for "${plan.command}" is missing array "${plan.pagination.itemKey}"`);
    }
    items.push(...pageItems);

    const hasMore = payload.hasMore;
    const cursor = payload.cursor;
    if (typeof hasMore !== "boolean" || (cursor !== null && typeof cursor !== "string")) {
      throw new Error(`Response for "${plan.command}" has invalid pagination metadata`);
    }

    if (!hasMore) {
      return { ...payload, [plan.pagination.itemKey]: items, hasMore: false, cursor: null };
    }
    if (!cursor) throw new Error(`Response for "${plan.command}" says more results exist but has no cursor`);
    if (seenCursors.has(cursor)) throw new Error(`Response for "${plan.command}" repeated pagination cursor "${cursor}"`);
    if (maxItems !== undefined && items.length >= maxItems) {
      return { ...payload, [plan.pagination.itemKey]: items, hasMore: true, cursor };
    }
    seenCursors.add(cursor);
    url.searchParams.set("cursor", cursor);
  }
}

export function renderDryRun(plan: RequestPlan): unknown {
  const redactedBody = redact(plan.body);
  if (
    plan.command.startsWith("webhooks ")
    && isRecord(redactedBody)
    && typeof redactedBody.url === "string"
  ) {
    redactedBody.url = redactWebhookUrl(redactedBody.url);
  }
  return {
    method: plan.method,
    url: plan.url,
    auth: { source: plan.auth.source },
    headers: redact(plan.headers),
    ...(plan.body !== undefined ? { body: redactedBody } : {}),
  };
}

function fillPath(path: string, params: Record<string, string>): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => {
    const value = params[key];
    if (!value) throw new Error(`Missing path parameter "${key}"`);
    return encodeURIComponent(value);
  });
}

function formatPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload);
}
