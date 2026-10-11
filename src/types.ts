export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type ColorMode = "auto" | "always" | "never";
export type OutputFormat = "json" | "pretty" | "human";

export type ResourceKind =
  | "notes"
  | "note"
  | "transcript"
  | "folders"
  | "audit-events"
  | "webhooks"
  | "webhook";

export interface UnknownFlag {
  readonly name: string;
  readonly value: string | boolean;
}

export interface ParsedArgs {
  readonly command: string[];
  readonly flags: Record<string, string | boolean | string[]>;
  readonly unknownFlags: UnknownFlag[];
}

export interface Profile {
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
}

export interface GlobalOptions {
  readonly profile?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly format: OutputFormat;
  readonly all: boolean;
  readonly maxItems?: number;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly color: ColorMode;
  readonly quiet: boolean;
  readonly verbose: boolean;
  readonly noInput: boolean;
  readonly version: boolean;
  readonly timeoutMs: number;
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
  readonly timeoutMs: number;
}

export interface Operation {
  readonly name: string;
  readonly resource: ResourceKind;
  readonly mutation: boolean;
  readonly plan: RequestPlan;
}
