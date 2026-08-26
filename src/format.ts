import type { OutputFormat, ResourceKind } from "./types.js";
import { isRecord } from "./util.js";

export function formatResult(resource: ResourceKind, value: unknown, format: OutputFormat): string {
  if (format === "json") return `${JSON.stringify(value, null, 2)}\n`;
  if (resource === "note") return formatNote(value, format);
  if (resource === "transcript") return formatTranscript(value, format);
  if (resource === "notes") return formatCollection(value, "notes", noteRow, format);
  if (resource === "folders") return formatCollection(value, "folders", folderRow, format);
  if (resource === "audit") return formatCollection(value, "events", auditRow, format);
  if (resource === "webhooks") return formatCollection(value, "webhook_endpoints", webhookRow, format);
  return formatWebhook(value, format);
}

function formatNote(value: unknown, format: Exclude<OutputFormat, "json">): string {
  if (!isRecord(value)) return scalar(value);
  const title = text(value.title) || "Untitled note";
  const owner = isRecord(value.owner) ? [text(value.owner.name), text(value.owner.email)].filter(Boolean).join(" <") : "";
  const ownerText = owner.includes("<") ? `${owner}>` : owner;
  const summary = format === "markdown" ? text(value.summary_markdown) || text(value.summary_text) : text(value.summary_text);
  const metadataRows: Array<[string, string]> = [
    ["ID", text(value.id)],
    ["Owner", ownerText],
    ["Created", text(value.created_at)],
    ["Updated", text(value.updated_at)],
    ["URL", text(value.web_url)],
  ];
  const metadata = metadataRows.filter((row) => row[1] !== "");

  if (format === "markdown") {
    const lines = [`# ${escapeMarkdown(title)}`, ""];
    for (const [label, item] of metadata) lines.push(`- **${label}:** ${escapeMarkdown(item)}`);
    if (summary) lines.push("", "## Summary", "", summary);
    if (Array.isArray(value.transcript)) {
      lines.push("", "## Transcript", "", formatTranscriptItems(value.transcript, "markdown").trimEnd());
    }
    return `${lines.join("\n")}\n`;
  }

  const lines = [title, ...metadata.map(([label, item]) => `${label}: ${item}`)];
  if (summary) lines.push("", "Summary", summary);
  if (Array.isArray(value.transcript)) lines.push("", "Transcript", formatTranscriptItems(value.transcript, "text").trimEnd());
  return `${lines.join("\n")}\n`;
}

function formatTranscript(value: unknown, format: Exclude<OutputFormat, "json">): string {
  if (!isRecord(value) || !Array.isArray(value.transcript)) return scalar(value);
  return formatTranscriptItems(value.transcript, format);
}

function formatTranscriptItems(items: unknown[], format: Exclude<OutputFormat, "json">): string {
  const lines = items.map((item) => {
    if (!isRecord(item)) return scalar(item).trimEnd();
    const speaker = speakerName(item.speaker);
    const start = text(item.start_time);
    const words = text(item.text);
    if (format === "markdown") {
      const time = start ? ` (${escapeMarkdown(start)})` : "";
      return `**${escapeMarkdown(speaker)}**${time}: ${escapeMarkdown(words)}`;
    }
    return `${start ? `[${start}] ` : ""}${speaker}: ${words}`;
  });
  return `${lines.join("\n")}\n`;
}

function formatCollection(
  value: unknown,
  key: string,
  rowBuilder: (item: Record<string, unknown>) => string[],
  format: Exclude<OutputFormat, "json">,
): string {
  if (!isRecord(value) || !Array.isArray(value[key])) return scalar(value);
  const records = value[key].filter(isRecord);
  if (records.length === 0) return format === "markdown" ? "_No results._\n" : "No results.\n";
  const rows = records.map(rowBuilder);
  const headers = collectionHeaders(key);
  if (format === "markdown") return markdownTable(headers, rows);
  return `${[headers, ...rows].map((row) => row.join("\t")).join("\n")}\n`;
}

function noteRow(item: Record<string, unknown>): string[] {
  const owner = isRecord(item.owner) ? text(item.owner.email) : "";
  return [text(item.id), text(item.title), owner, text(item.created_at), text(item.updated_at)];
}

function folderRow(item: Record<string, unknown>): string[] {
  return [text(item.id), text(item.name), text(item.parent_folder_id)];
}

function auditRow(item: Record<string, unknown>): string[] {
  return [text(item.id), text(item.action), text(item.occurred_at), speakerName(item.actor)];
}

function webhookRow(item: Record<string, unknown>): string[] {
  return [
    text(item.id),
    text(item.enabled),
    text(item.url),
    listText(item.scopes),
    listText(item.events),
  ];
}

function formatWebhook(value: unknown, format: Exclude<OutputFormat, "json">): string {
  if (!isRecord(value)) return scalar(value);
  const rows = Object.entries(value).map(([key, item]) => [key, displayValue(item)]);
  if (format === "markdown") return markdownTable(["Field", "Value"], rows);
  return `${rows.map((row) => row.join("\t")).join("\n")}\n`;
}

function collectionHeaders(key: string): string[] {
  if (key === "notes") return ["ID", "Title", "Owner", "Created", "Updated"];
  if (key === "folders") return ["ID", "Name", "Parent folder ID"];
  if (key === "events") return ["ID", "Action", "Occurred", "Actor"];
  return ["ID", "Enabled", "URL", "Scopes", "Events"];
}

function markdownTable(headers: string[], rows: string[][]): string {
  const render = (row: string[]) => `| ${row.map((cell) => escapeTableCell(cell)).join(" | ")} |`;
  return `${[render(headers), render(headers.map(() => "---")), ...rows.map(render)].join("\n")}\n`;
}

function speakerName(value: unknown): string {
  if (!isRecord(value)) return "Unknown";
  return text(value.name) || text(value.diarization_label) || text(value.email) || text(value.attribution) || text(value.object) || text(value.source) || "Unknown";
}

function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => displayValue(item)).join(", ");
  if (isRecord(value)) return JSON.stringify(value);
  return text(value);
}

function listText(value: unknown): string {
  return Array.isArray(value) ? value.map(text).join(",") : "";
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function scalar(value: unknown): string {
  return `${text(value)}\n`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+.!|>-])/g, "\\$1");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}
