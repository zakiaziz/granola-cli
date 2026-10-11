// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
export type OutputFormat = "json" | "pretty" | "human";
export type ColorMode = "auto" | "always" | "never";

export const HTTP_METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
export const SAFE_METHODS: readonly HttpMethod[] = ["GET", "HEAD", "OPTIONS"];

export const SHELLS: readonly string[] = ["bash", "zsh", "fish"];

export interface GlobalOptions {
  profile?: string;
  format: OutputFormat;
  color: ColorMode;
  quiet: boolean;
  verbose: boolean;
  noInput: boolean;
  timeoutMs: number;
}

export interface PackageInfo {
  version: string;
  description: string;
}
