import type { Endpoint } from "./types.js";

const docs = (page: string) => `https://docs.granola.ai/api-reference/${page}`;

export const endpoints: readonly Endpoint[] = [
  {
    name: "notes list",
    pattern: ["notes", "list"],
    method: "GET",
    path: "/v1/notes",
    resource: "notes",
    pagination: { itemKey: "notes", maxPageSize: 30 },
    docs: docs("list-notes"),
  },
  {
    name: "note show",
    pattern: ["note", "show", ":noteId"],
    method: "GET",
    path: "/v1/notes/:noteId",
    resource: "note",
    docs: docs("get-note"),
  },
  {
    name: "note transcript",
    pattern: ["note", "transcript", ":noteId"],
    method: "GET",
    path: "/v1/notes/:noteId/transcript",
    resource: "transcript",
    pagination: { itemKey: "transcript", maxPageSize: 100 },
    docs: docs("get-transcript"),
  },
  {
    name: "folders list",
    pattern: ["folders", "list"],
    method: "GET",
    path: "/v1/folders",
    resource: "folders",
    pagination: { itemKey: "folders", maxPageSize: 30 },
    docs: docs("list-folders"),
  },
  {
    name: "audit list",
    pattern: ["audit", "list"],
    method: "GET",
    path: "/v1/audit",
    resource: "audit",
    pagination: { itemKey: "events", maxPageSize: 30 },
    docs: "https://docs.granola.ai/audit-events",
  },
  {
    name: "webhooks list",
    pattern: ["webhooks", "list"],
    method: "GET",
    path: "/v1/webhook-endpoints",
    resource: "webhooks",
    docs: docs("list-webhook-endpoints"),
  },
  {
    name: "webhooks create",
    pattern: ["webhooks", "create"],
    method: "POST",
    path: "/v1/webhook-endpoints",
    resource: "webhook",
    mutation: true,
    docs: docs("create-webhook-endpoint"),
  },
  {
    name: "webhooks update",
    pattern: ["webhooks", "update", ":webhookId"],
    method: "PATCH",
    path: "/v1/webhook-endpoints/:webhookId",
    resource: "webhook",
    mutation: true,
    docs: docs("update-webhook-endpoint"),
  },
  {
    name: "webhooks delete",
    pattern: ["webhooks", "delete", ":webhookId"],
    method: "DELETE",
    path: "/v1/webhook-endpoints/:webhookId",
    resource: "webhook",
    mutation: true,
    docs: docs("delete-webhook-endpoint"),
  },
];

export function findEndpoint(
  command: readonly string[],
): { endpoint: Endpoint; params: Record<string, string> } | undefined {
  for (const endpoint of endpoints) {
    if (endpoint.pattern.length !== command.length) continue;
    const params: Record<string, string> = {};
    const matches = endpoint.pattern.every((part, index) => {
      const value = command[index];
      if (value === undefined) return false;
      if (part.startsWith(":")) {
        params[part.slice(1)] = value;
        return true;
      }
      return part === value;
    });
    if (matches) return { endpoint, params };
  }
  return undefined;
}
