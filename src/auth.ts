import { readConfig, readProfile, resolveProfileName } from "./config.js";
import type { GlobalOptions, Profile, ResolvedAuth } from "./types.js";
import { environmentValue } from "./util.js";
import { validateBaseUrl } from "./values.js";

export interface RuntimeContext {
  readonly profileName?: string;
  readonly profile?: Profile;
  readonly baseUrl: string;
}

export function loadRuntimeContext(options: GlobalOptions): RuntimeContext {
  const profileName = resolveProfileName(options.profile);
  const profile = readProfile(profileName);
  const config = readConfig();
  const baseUrl =
    options.baseUrl ??
    environmentValue("GRANOLA_BASE_URL") ??
    profile?.baseUrl ??
    config.baseUrl ??
    "https://public-api.granola.ai";

  return {
    ...(profileName ? { profileName } : {}),
    ...(profile ? { profile } : {}),
    baseUrl: validateBaseUrl(baseUrl),
  };
}

export function resolveApiKey(options: GlobalOptions, context: RuntimeContext): ResolvedAuth {
  if (options.apiKey) return { token: options.apiKey, source: "--api-key" };
  const environmentKey = environmentValue("GRANOLA_API_KEY");
  if (environmentKey) return { token: environmentKey, source: "GRANOLA_API_KEY" };
  if (context.profile?.apiKey) {
    return { token: context.profile.apiKey, source: `profile:${context.profileName}` };
  }
  return {};
}

export function requireApiKey(auth: ResolvedAuth, commandName: string): Required<ResolvedAuth> {
  if (auth.token && auth.source) return { token: auth.token, source: auth.source };
  throw new Error(
    `Missing API key for "${commandName}". Use --api-key, GRANOLA_API_KEY, or run granola setup.`,
  );
}
