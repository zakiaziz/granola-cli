// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import type { Access, Tool } from "./access.js";
import { Client, type Call } from "./client.js";
import { completionScript } from "./completions.js";
import { credentialFor, credentialNoun, credentialOptionsText, fieldSets, isPerRequest, setLabel } from "./credentials.js";
import { asCliError, CliError, usageError, type StepPartial } from "./errors.js";
import { jsonContentType } from "./http.js";
import { printRaw, printResult, printText } from "./output.js";
import { profileCommands } from "./profiles.js";
import type { Provider, VerifyCheck } from "./provider.js";
import {
  DRY_RUN_OPTION,
  FILE_OPTION,
  QUERY_OPTION,
  YES_OPTION,
  credentialOption,
  DEFAULT_CREDENTIAL_OPTION,
  failureList,
  networkFailures,
  type CommandSpec,
  type Context,
  type CredentialOptionName,
  type Exception,
  type GroupSpec,
  type OptionSpec,
  type Registry,
} from "./registry.js";
import { SAFE_METHODS, SHELLS, type HttpMethod } from "./types.js";
import { echoable, invalidValue, listWords, parseChoice, parseKeyValue, readJsonFile, redactCredentials } from "./values.js";

const GRAPHQL_PATH = "/graphql";

/** What one verify check proved, led by the credential name under the key of the credential option when there are several. */
type CheckResult = Record<string, unknown> & { check: string; scope: string; identity?: unknown };

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
  private readonly credentialName: CredentialOptionName;

  constructor(
    private readonly tool: Tool,
    private readonly registry: () => Registry,
  ) {
    this.provider = tool.provider;
    this.bin = tool.provider.bin;
    this.credentialName = tool.provider.credentialOption ?? DEFAULT_CREDENTIAL_OPTION;
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
    const flag = `--${this.credentialName.name}`;
    const example = `${this.bin} auth verify${several ? ` ${flag} ${named[0] ?? ""}` : ""}`;
    const single = `data has verified, profile, base_url, check${identity}`;
    return {
      path: ["auth", "verify"],
      summary: `Verify the ${noun}.`,
      arguments: [],
      options: several ? [credentialOption(named, this.credentialName, "verify")] : [],
      kind: "network",
      effects: {
        kind: "read",
        summary: several
          ? [
              ...checks.map((check) => `${flag} ${check.credential ?? ""}: ${check.effect}`),
              `Without ${flag}, runs the check of every ${this.credentialName.noun} that the profile stores, one request each. When some checks fail and others pass, it exits 8 with PARTIAL_FAILURE and lists both.`,
            ].join("\n")
          : (checks[0]?.effect ?? ""),
      },
      output: several
        ? `Resource envelope. With ${flag}, ${single}. Without it, data has verified, profile, base_url, and checks, one entry per check with ${this.resultKey()}, check${identity}. meta has profile.`
        : `Resource envelope. ${single}; meta has profile.`,
      failures: networkFailures({ identified: false, partial: several || this.provider.protocol === "graphql", mutation: false }),
      examples: [example, `${example} --profile work --format json`],
      run: (context) => this.authVerify(context),
    };
  }

  private apiRequestSpec(): CommandSpec {
    const { api, authScheme } = this.provider;
    const mutating = api.methods.filter((method) => !SAFE_METHODS.includes(method));
    const safe = api.methods.filter((method) => SAFE_METHODS.includes(method));
    const safeSentence =
      safe.length > 0 ? ` ${listWords(safe, "and")} ${safe.length > 1 ? "are read only and reject" : "is read only and rejects"} --yes, --dry-run, and --file.` : "";
    const fileRequired = api.bodyCheck !== undefined;
    const sets = fieldSets(this.provider);
    const options: OptionSpec[] = [
      QUERY_OPTION,
      fileRequired ? { ...FILE_OPTION, required: true } : FILE_OPTION,
      YES_OPTION,
      DRY_RUN_OPTION,
      ...(isPerRequest(this.provider) ? [credentialOption(sets.map((set) => set.name), this.credentialName, "send")] : []),
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
        summary: `Applies to ${listWords(mutating, "and")}.${safeSentence} Sends the selected profile credentials only to the configured API origin, as ${authScheme}, with an ${jsonContentType(this.provider)} body. Safe methods retry up to 3 attempts. Mutations make one attempt.`,
      },
      ...(this.provider.accessLevels ? { writeAccess: "mutating-methods" as const } : {}),
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
    if (this.checks().length > 1 && !context.options.has(this.credentialName.name)) return this.verifyAvailable(context);
    const { access, result, notices } = await this.runCheck(context, this.selectedCheck(context));
    const { [this.resultKey()]: _credential, ...single } = result;
    printResult(
      { verified: true, ...this.identified(access), base_url: access.baseUrl, ...single },
      { profile: access.profileName, ...(notices === undefined ? {} : { provider: notices }) },
    );
  }

  /** Runs every check whose credential is available. A check that fails does not stop the others (CLI-ERR-4). */
  private async verifyAvailable(context: Context): Promise<void> {
    const access = new Client(this.tool, context).access();
    const available = this.checks().filter((check) => credentialFor(this.provider, access.credential, check.credential) !== undefined);
    if (available.length === 0) throw this.noCredential(access);
    const passed: { check: VerifyCheck; result: CheckResult }[] = [];
    const failed: { check: VerifyCheck; failure: CliError }[] = [];
    for (const check of available) {
      try {
        passed.push({ check, result: (await this.runCheck(context, check)).result });
      } catch (error) {
        failed.push({ check, failure: asCliError(error) });
      }
    }
    const first = failed[0];
    if (first && passed.length === 0) throw first.failure;
    if (first) throw this.partialVerification(passed, failed);
    printResult(
      { verified: true, ...this.identified(access), base_url: access.baseUrl, checks: passed.map((item) => item.result) },
      { profile: access.profileName },
    );
  }

  /** The key that names the credential in a check result: the credential option's name in snake case. */
  private resultKey(): string {
    return this.credentialName.name.replaceAll("-", "_");
  }

  private identified(access: Access): { profile: string } {
    return { profile: access.profileName };
  }

  private noCredential(access: Access): CliError {
    const sets = fieldSets(this.provider);
    return new CliError("AUTHENTICATION_REQUIRED", `Profile "${access.profileName}" has no ${this.provider.name} ${credentialNoun(this.provider, sets)}.`, {
      hint: `Run '${this.bin} profiles update ${access.profileName}' with ${credentialOptionsText(sets)}.`,
    });
  }

  private partialVerification(
    passed: readonly { check: VerifyCheck; result: CheckResult }[],
    failed: readonly { check: VerifyCheck; failure: CliError }[],
  ): CliError {
    const flag = `--${this.credentialName.name}`;
    const name = (check: VerifyCheck): string => `verify ${check.credential ?? ""}`.trim();
    const partial: StepPartial = {
      completed: passed.map((item) => ({ step: name(item.check), result: item.result })),
      failed: failed.map(({ check, failure }) => ({
        step: name(check),
        error: { code: failure.code, message: failure.message, ...(failure.extra.provider ? { provider: failure.extra.provider } : {}) },
      })),
      not_attempted: [],
    };
    const first = failed[0]?.check.credential ?? "";
    return new CliError("PARTIAL_FAILURE", `${passed.length} of ${passed.length + failed.length} checks passed.`, {
      hint: `Run '${this.bin} auth verify ${flag} ${first}' for the details of one failed check.`,
      retryable: false,
      details: { cause: failed[0]?.failure.code },
      partial,
    });
  }

  /** Sends one check and reports what it proved. */
  private async runCheck(context: Context, check: VerifyCheck): Promise<{ access: Access; result: CheckResult; notices?: unknown }> {
    const client = new Client(this.tool, context, check.credential);
    const path = typeof check.path === "function" ? check.path(client.endpoint) : check.path;
    let identity: unknown;
    const sent = await client.send({
      method: check.method,
      path,
      query: check.query,
      mutation: false,
      ...(check.body === undefined ? {} : { body: check.body }),
      ...(check.field === undefined ? {} : { field: check.field }),
      settle: ({ data }, _context, helpers) => {
        check.validate?.(data);
        if (check.identity) identity = check.identity(data, helpers);
        return data;
      },
    });
    const query = new URLSearchParams(check.query).toString();
    const result: CheckResult = {
      ...(check.credential === undefined ? {} : { [this.resultKey()]: check.credential }),
      check: check.label ?? `${check.method} ${path}${query === "" ? "" : `?${query}`}`,
      scope: check.identity
        ? "The credential identifies the caller. It does not prove complete permission coverage."
        : "The credential was accepted for this check only. It does not prove complete permission coverage.",
      ...(check.identity ? { identity } : {}),
    };
    return { access: client.access(), result, ...(sent.meta.provider === undefined ? {} : { notices: sent.meta.provider }) };
  }

  private selectedCheck(context: Context): VerifyCheck {
    const checks = this.checks();
    const wanted = context.options.string(this.credentialName.name);
    const check = checks.length === 1 ? checks[0] : checks.find((candidate) => candidate.credential === wanted);
    if (check) return check;
    throw usageError(
      `--${this.credentialName.name} must name a ${this.credentialName.noun} with a check; received "${wanted ?? ""}".`,
      `Use --${this.credentialName.name} ${checks[0]?.credential ?? "NAME"}.`,
    );
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
    const client = new Client(this.tool, context, context.options.string(this.credentialName.name));
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
