export function environmentValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertRecord(value: unknown, context: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} must be a JSON object`);
}
