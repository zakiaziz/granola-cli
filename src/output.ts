import type { OutputFormat, ResourceKind } from "./types.js";
import { formatResult } from "./format.js";

export function printResult(resource: ResourceKind, value: unknown, format: OutputFormat): void {
  process.stdout.write(formatResult(resource, value, format));
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printText(value: string): void {
  process.stdout.write(`${value}\n`);
}
