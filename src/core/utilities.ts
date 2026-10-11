// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { credentialSource, reportedProfile, type Tool } from "./access.js";
import { Client, type Call } from "./client.js";
import { completionScript } from "./completions.js";
import { credentialNoun, fieldSets, isPerRequest, setLabel } from "./credentials.js";
import { usageError } from "./errors.js";
import { printRaw, printResult, printText } from "./output.js";
import { profileCommands } from "./profiles.js";
import type { Provider, VerifyCheck } from "./provider.js";
import {
  DRY_RUN_OPTION,
  FILE_OPTION,
  QUERY_OPTION,
  YES_OPTION,
  credentialOption,
  failureList,
  networkFailures,
  type CommandSpec,
  type Context,
  type Exception,
  type GroupSpec,
  type OptionSpec,
  type Registry,
} from "./registry.js";
import { SAFE_METHODS, SHELLS, type HttpMethod } from "./types.js";
import { echoable, invalidValue, listWords, parseChoice, parseKeyValue, readJsonFile, redactCredentials } from "./values.js";

const GRAPHQL_PATH = "/graphql";

/** Recorded in the help of every GraphQL provider's api request, so all tools say the same thing. */
const GRAPHQL_API_EXCEPTION: Exception = {
  rule: "STYLE-API-1",
  reason: "GraphQL accepts POST /graphql only, so other methods and paths fail.",
};

export const UTILITY_GROUP_SPECS: readonly GroupSpec[] = [
  { path: ["profiles"], summary: "Manage saved profiles.", title: "Manage saved profiles." },
  { path: ["config"], summary: "Read and change configuration.", title: "Manage tool settings." },
  { path: ["auth"], summary: "Verify credentials.", title: "Inspect credentials." },
  { path: ["api"], summary: "Send a raw API request.", title: "Send raw API requests." },
];

/** Builds the utility command specs (STYLE-GRAM-6) for a provider. Every string here is shared by all tools. */
export function utilityCommands(tool: Tool, registry: () => Registry): CommandSpec[] {
  return new Utilities(tool, registry).commands();
}

class Utilities {
  private readonly provider: Provider;
  private readonly bin: string;

  constructor(
    private readonly tool: Tool,
    private readonly registry: () => Registry,
  ) {
    this.provider = tool.provider;
    this.bin = tool.provider.bin;
  }

  commands(): CommandSpec[] {
    return [...profileCommands(this.tool), this.authVerifySpec(), this.apiRequestSpec(), this.completionsSpec()];
  }

  // Specs

  private checks(): VerifyCheck[] {
    return Array.isArray(this.provider.verify) ? this.provider.verify : [this.provider.verify];
  }

  private authVerifySpec(): CommandSpec {
    const checks = this.checks();
    const several = checks.length > 1;
    const identity = checks.some((check) => check.identity) ? ", scope, and identity" : ", and scope";
    const named = checks.flatMap((check) => (check.credential === undefined ? [] : [check.credential]));
    const sets = fieldSets(this.provider).filter((set) => named.includes(set.name));
    const noun = sets.length > 0 ? listWords(sets.map(setLabel), "or") : credentialNoun(this.provider);
    return {
      path: ["auth", "verify"],
      summary: `Verify the ${noun}.`,
      arguments: [],
      options: several ? [credentialOption(named)] : [],
      kind: "network",
      effects: {
        kind: "read",
        summary: several
          ? checks.map((check) => `--credential ${check.credential ?? ""}: ${check.effect}`).join("\n")
          : (checks[0]?.effect ?? ""),
      },
      output: `Resource envelope. data has verified, profile, credential_source, base_url, check${identity}; meta is empty.`,
      failures: networkFailures({ identified: false, partial: this.provider.protocol === "graphql", mutation: false }),
      examples: [
        `${this.bin} auth verify${several ? ` --credential ${named[0] ?? ""}` : ""}`,
        `${this.bin} auth verify${several ? ` --credential ${named[0] ?? ""}` : ""} --profile work --format human`,
      ],
      run: (context) => this.authVerify(context),
    };
  }

  private apiRequestSpec(): CommandSpec {
    const { api, authScheme } = this.provider;
    const mutating = api.methods.filter((method) => !SAFE_METHODS.includes(method));
    const safe = api.methods.filter((method) => SAFE_METHODS.includes(method));
    const safeSentence =
      safe.length > 0 ? ` ${listWords(safe, "and")} ${safe.length > 1 ? "are" : "is"} read only and reject --yes, --dry-run, and --file.` : "";
    const fileRequired = api.bodyCheck !== undefined;
    const sets = fieldSets(this.provider);
    const options: OptionSpec[] = [
      QUERY_OPTION,
      fileRequired ? { ...FILE_OPTION, required: true } : FILE_OPTION,
      YES_OPTION,
      DRY_RUN_OPTION,
      ...(isPerRequest(this.provider) ? [credentialOption(sets.map((set) => set.name))] : []),
    ];
    const exceptions = [...(api.graphql ? [GRAPHQL_API_EXCEPTION] : []), ...(api.exceptions ?? [])];
    return {
      path: ["api", "request"],
      summary: "Send a raw API request.",
      arguments: [
        {
          name: "METHOD",
          description: "HTTP method.",
          choices: [...api.methods],
          check: (value) => parseChoice("METHOD", value, api.methods),
        },
        api.graphql
          ? {
              name: "PATH",
              description: "GraphQL endpoint path.",
              choices: [GRAPHQL_PATH],
              check: validateGraphqlPath,
            }
          : { name: "PATH", description: "Path on the configured API origin. Starts with /.", check: validateApiPath },
      ],
      options,
      kind: "network",
      effects: {
        kind: "remote-mutation",
        summary: `Applies to ${listWords(mutating, "and")}.${safeSentence} Sends the selected profile credentials only to the configured API origin, as ${authScheme}, with an application/json body. Safe methods retry up to 3 attempts. Mutations make one attempt.`,
      },
      output:
        "Provider body as parsed JSON, a JSON string for non-JSON text, or null for an empty body. Binary responses fail. --format still applies.",
      failures: failureList([
        ...networkFailures({ identified: true, partial: false, mutation: true }),
        "UNSUPPORTED_RESPONSE",
      ]),
      examples: api.examples,
      ...(exceptions.length > 0 ? { exceptions } : {}),
      run: (context) => this.apiRequest(context),
    };
  }

  private completionsSpec(): CommandSpec {
    return {
      path: ["completions"],
      summary: "Print a shell completion script.",
      arguments: [
        { name: "SHELL", description: "Shell name.", choices: [...SHELLS], check: (value) => parseChoice("SHELL", value, SHELLS) },
      ],
      options: [],
      kind: "text",
      effects: { kind: "none" },
      output: "Shell script on stdout. It edits no files.",
      failures: ["INVALID_ARGUMENT"],
      examples: [`${this.bin} completions bash`, `${this.bin} completions zsh`],
      run: (context) => this.completions(context),
    };
  }

  // Handlers

  private async authVerify(context: Context): Promise<void> {
    const check = this.selectedCheck(context);
    const client = new Client(this.tool, context, check.credential);
    const path = typeof check.path === "function" ? check.path(client.endpoint) : check.path;
    const shaped = await client.send({
      method: check.method,
      path,
      query: check.query,
      mutation: false,
      ...(check.body === undefined ? {} : { body: check.body }),
      ...(check.field === undefined ? {} : { field: check.field }),
    });
    check.validate?.(shaped.data);
    const access = client.access();
    const query = new URLSearchParams(check.query).toString();
    printResult({
      verified: true,
      profile: reportedProfile(access),
      credential_source: credentialSource(access),
      base_url: access.baseUrl,
      check: check.label ?? `${check.method} ${path}${query === "" ? "" : `?${query}`}`,
      scope: check.identity
        ? "The credential identifies the caller. It does not prove complete permission coverage."
        : "The credential was accepted for this check only. It does not prove complete permission coverage.",
      ...(check.identity ? { identity: check.identity(shaped.data) } : {}),
    });
  }

  private selectedCheck(context: Context): VerifyCheck {
    const checks = this.checks();
    const wanted = context.options.string("credential");
    const check = checks.length === 1 ? checks[0] : checks.find((candidate) => candidate.credential === wanted);
    if (check) return check;
    throw usageError(`--credential must name a credential with a check; received "${wanted ?? ""}".`, `Use --credential ${checks[0]?.credential ?? "NAME"}.`);
  }

  private async apiRequest(context: Context): Promise<void> {
    const method = context.args[0] as HttpMethod;
    const path = context.args[1] ?? "";
    const safe = SAFE_METHODS.includes(method);
    if (safe) rejectOnSafeMethod(context, method);
    const file = context.options.string("file");
    const body = file === undefined ? undefined : readJsonFile("--file", file);
    if (body !== undefined) this.provider.api.bodyCheck?.(body);
    const call: Call = {
      method,
      path,
      query: context.options.strings("query").map((pair) => parseKeyValue("--query", pair)),
      ...(body === undefined ? {} : { body }),
      mutation: !safe,
      raw: true,
    };
    const client = new Client(this.tool, context, context.options.string("credential"));
    const shaped = safe
      ? await client.send(call)
      : (
          await client.mutate({
            effect: `Sends ${method} ${path} to ${this.provider.name}. The effect depends on the endpoint.`,
            steps: [{ name: "api request", call }],
          })
        )?.[0];
    if (shaped) printRaw(shaped.data);
  }

  private async completions(context: Context): Promise<void> {
    printText(completionScript(this.registry(), context.args[0] ?? ""));
  }
}

const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

function validateApiPath(value: string): string {
  const received = redactCredentials(value);
  const fail = (constraint: string, hint: string): never => {
    throw usageError(`PATH must ${constraint}; received "${received}".`, hint, { argument: "PATH", received });
  };
  if (!value.startsWith("/") || value.startsWith("//")) fail("start with a single /", "Use a path that starts with /.");
  if (value.includes("?")) fail("not contain a query string", "Use --query KEY=VALUE.");
  if (value.includes("#")) fail("not contain a fragment", "Remove the fragment.");
  if (/[\u0000- \u007f\\]/.test(value)) fail("not contain whitespace, control characters, or backslashes", "Percent-encode the character.");
  if (value.split("/").some((part) => DOT_SEGMENT.test(part))) fail("not contain . or .. segments", "Remove the . and .. segments.");
  return value;
}

function validateGraphqlPath(value: string): string {
  if (value === GRAPHQL_PATH) return value;
  const received = echoable(redactCredentials(value));
  throw invalidValue("PATH", `be ${GRAPHQL_PATH}`, received, `Use PATH ${GRAPHQL_PATH}.`, GRAPHQL_PATH);
}

function rejectOnSafeMethod(context: Context, method: string): void {
  for (const option of ["yes", "dry-run", "file"]) {
    if (!context.options.has(option)) continue;
    throw usageError(`--${option} cannot be used with ${method}.`, `Remove --${option}; ${method} requests change nothing.`);
  }
}
