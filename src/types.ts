export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type OutputFormat = "json" | "text" | "markdown";

export type ResourceKind =
  | "notes"
  | "note"
  | "transcript"
  | "folders"
  | "audit"
  | "webhooks"
  | "webhook";

export interface UnknownFlag {
  readonly name: string;
  readonly value: string | boolean;
}

export interface ParsedArgs {
  readonly command: string[];
  readonly flags: Record<string, string | boolean>;
  readonly unknownFlags: UnknownFlag[];
}

export interface Profile {
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export interface GlobalOptions {
  readonly profile?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly format: OutputFormat;
  readonly all: boolean;
  readonly maxItems?: number;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

export interface ResolvedAuth {
  readonly token?: string;
  readonly source?: string;
}

export interface PaginationSpec {
  readonly itemKey: "notes" | "transcript" | "folders" | "events";
  readonly maxPageSize: number;
}

export interface Endpoint {
  readonly name: string;
  readonly pattern: readonly string[];
  readonly method: HttpMethod;
  readonly path: string;
  readonly resource: ResourceKind;
  readonly mutation?: boolean;
  readonly pagination?: PaginationSpec;
  readonly docs: string;
}

export interface RequestPlan {
  readonly command: string;
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly auth: Required<ResolvedAuth>;
  readonly body?: unknown;
  readonly pagination?: PaginationSpec;
}

export interface Operation {
  readonly name: string;
  readonly resource: ResourceKind;
  readonly mutation: boolean;
  readonly plan: RequestPlan;
}
