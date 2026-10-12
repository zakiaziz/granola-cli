// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import {
  credentialSource,
  reportedProfile,
  requireCredential,
  resolveAccess,
  Endpoint,
  type Access,
  type Tool,
} from "./access.js";
import { credentialFor, credentialVariables, setsFor } from "./credentials.js";
import { confirmMutation, type ShownChange } from "./confirm.js";
import { asCliError, CliError, stepsFailure, type ErrorCode, type StepPartial } from "./errors.js";
import { buildPlan, decodeRaw, displayUrl, guardHook, performRequest, scrubDeep, type Exchange, type RequestPlan } from "./http.js";
import { printResult } from "./output.js";
import { traverse } from "./pagination.js";
import type { HookHelpers, RequestSpec, ResponseShape } from "./provider.js";
import type { Context } from "./registry.js";
import { hookHelpers, shapeResponse, unwrap, type ShapeCall, type Shaped } from "./shape.js";
import type { HttpMethod } from "./types.js";
import { redact, REDACTED } from "./values.js";

/** One request, with how to read its response. */
export interface Call extends RequestSpec, ResponseShape {
  method: HttpMethod;
  /** Changes remote state. A POST search is a read. */
  mutation: boolean;
  /** Credential set to send. Default: the command's. */
  credential?: string;
  /** Return the response as raw JSON or text without shaping it (api request). */
  raw?: boolean;
}

export interface Change {
  field: string;
  before: unknown;
  after: unknown;
}

/** One request of a mutation, named for confirmation, previews, and partial results. */
export interface Step {
  name: string;
  call: Call;
  /**
   * Runs on the shaped response. Throw CliError, for example INVALID_RESPONSE, when the response is not what the step
   * expects. The core scrubs the error before it prints.
   */
  validate?(data: unknown, helpers: HookHelpers): void;
}

/** How Client.poll reads a response again until the work it waits for is done. */
export interface PollOptions {
  /** Time to wait before every read, the first included, so the first read follows the action that started the work. */
  intervalMs: number;
  /** Overall deadline for the whole poll. The --timeout of each read still applies, capped to the time left. */
  timeoutMs: number;
  /** Returns true when the shaped response shows the work is done. Throw CliError, for example INVALID_RESPONSE, for a response it cannot read; the core scrubs it. */
  until(data: unknown): boolean;
}

/** The ordered requests of one mutation, and what a preview and the confirmation prompt show about them. */
export interface MutationPlan {
  /** Effect sentence for the confirmation prompt, with identifiers filled in. */
  effect: string;
  steps: Step[];
  /** Field changes the mutation will make, read from the target. Shown in the preview and the prompt, redacted by field name. */
  changes?: Change[];
  /** What --dry-run validated. "local and remote read" when the plan came from reading the target. Default: "local". */
  validation?: "local" | "local and remote read";
}

/**
 * Sends the requests of one command. The core keeps credentials, retries, timeouts, error mapping, confirmation,
 * previews, and every message. A command's run hook composes send, paginate, and mutate.
 */
export class Client {
  /** Resolved endpoint fields. They are read on first use. */
  readonly endpoint: Endpoint;
  private resolved: Access | undefined;

  constructor(
    private readonly tool: Tool,
    private readonly context: Context,
    private readonly credential?: string,
  ) {
    this.endpoint = new Endpoint(tool.provider, () => this.access().endpoint);
  }

  /** The resolved profile, credential source, base URL, and endpoint fields. */
  access(): Access {
    this.resolved ??= resolveAccess(this.tool, this.context.globals);
    return this.resolved;
  }

  /** Sends one read. A mutation goes through mutate, which confirms it and honors --dry-run. Requires the credential. */
  async send(call: Call): Promise<Shaped> {
    if (call.mutation) throw new CliError("UNEXPECTED_ERROR", `${this.name()} sends a mutation through send; use mutate.`);
    return this.execute(this.plan(call, true), call);
  }

  /**
   * Reads one response again every intervalMs until `until` accepts it, or timeoutMs passes. Returns the accepted
   * response, or undefined at the deadline, including when the deadline cuts a read or its retry wait short. The deadline bounds the
   * retries of every read, so the poll never runs past it by a request timeout. Any other failure throws.
   */
  async poll(call: Call, options: PollOptions): Promise<Shaped | undefined> {
    if (call.mutation) throw new CliError("UNEXPECTED_ERROR", `${this.name()} polls with a mutation; a poll sends reads only.`);
    const plan = this.plan(call, true);
    const deadline = Date.now() + options.timeoutMs;
    while (true) {
      await sleep(Math.max(0, Math.min(options.intervalMs, deadline - Date.now())));
      if (Date.now() >= deadline) return undefined;
      try {
        const { shaped } = await this.exchange(plan, call, deadline);
        if (guardHook(plan, () => options.until(shaped.data))) return shaped;
      } catch (error) {
        const failure = asCliError(error);
        const retryable = failure.code === "TRANSIENT_FAILURE" || failure.code === "RATE_LIMITED";
        if (retryable && Date.now() >= deadline) return undefined;
        throw failure;
      }
    }
  }

  /** Reads a collection with the --page-size, --cursor, --all, and --max-items options of the command. */
  async paginate(call: Call): Promise<Shaped> {
    if (call.mutation) throw new CliError("UNEXPECTED_ERROR", `${this.name()} paginates a mutation.`);
    const spec = this.context.spec.pagination;
    const style = spec?.style ?? this.tool.provider.pagination;
    if (!spec || !style) {
      throw new CliError("UNEXPECTED_ERROR", `${this.name()} paginates without a pagination spec and style.`);
    }
    const { options } = this.context;
    const traversal = {
      pageSize: options.number("page-size") ?? spec.default,
      all: options.flag("all"),
      maxItems: options.number("max-items"),
      cursor: options.string("cursor"),
      window: spec.window,
    };
    return traverse(this.plan(call, true), this.shapeCall(call), style, traversal, this.context);
  }

  /**
   * Runs a mutation. With --dry-run it prints the preview and returns undefined. Otherwise it requires the
   * credential, confirms (--yes, or an interactive prompt that lists every request and change), and sends the steps in
   * order. A later step that fails reports PARTIAL_FAILURE with the completed, failed, and not attempted steps.
   * Returns the shaped response of every step.
   */
  async mutate(plan: MutationPlan): Promise<Shaped[] | undefined> {
    const { provider } = this.tool;
    const access = this.access();
    if (this.context.options.flag("dry-run")) {
      const previews = plan.steps.map((step) => this.plan(step.call, false));
      this.preview(plan, previews, access);
      return undefined;
    }
    const plans = plan.steps.map((step) => this.plan(step.call, true));
    const sets = new Map(plan.steps.flatMap((step) => setsFor(provider, step.call.credential ?? this.credential)).map((set) => [set.name, set]));
    await confirmMutation(
      {
        providerName: provider.name,
        profile: reportedProfile(access),
        credentialVariables: credentialVariables(provider, [...sets.values()]),
        operation: this.name(),
        requests: plans.map((item) => ({ method: item.method, url: displayUrl(item) })),
        changes: (plan.changes ?? []).map(shownChange),
        effect: plan.effect,
      },
      { yes: this.context.options.flag("yes"), globals: this.context.globals, stdinCarriesContent: stdinCarriesContent(this.context) },
    );
    return this.sendSteps(plan.steps, plans);
  }

  private async sendSteps(steps: Step[], plans: RequestPlan[]): Promise<Shaped[]> {
    const results: Shaped[] = [];
    for (const [index, step] of steps.entries()) {
      try {
        const plan = plans[index] as RequestPlan;
        const { shaped, exchange } = await this.exchange(plan, step.call);
        const { validate } = step;
        if (validate) guardHook(plan, () => validate(shaped.data, hookHelpers(step.call, plan, exchange)));
        results.push(shaped);
      } catch (error) {
        if (index === 0) throw error;
        throw partialFailure(steps, results, index, asCliError(error));
      }
    }
    return results;
  }

  private name(): string {
    return this.context.spec.path.join(" ");
  }

  private shapeCall(call: Call): ShapeCall {
    return { ...call, name: this.name() };
  }

  private plan(call: Call, requireCredentials: boolean): RequestPlan {
    const { provider } = this.tool;
    const access = this.access();
    const setName = call.credential ?? this.credential;
    const credential = requireCredentials ? requireCredential(provider, access, setName) : credentialFor(provider, access.credential, setName);
    return buildPlan(
      {
        method: call.method,
        path: call.path,
        query: call.query ?? [],
        ...(call.body === undefined ? {} : { body: call.body }),
        mutation: call.mutation,
        raw: call.raw ?? false,
        secretValues: call.secretValues ?? [],
      },
      { provider, access, credential, timeoutMs: this.context.globals.timeoutMs },
    );
  }

  private async execute(plan: RequestPlan, call: Call): Promise<Shaped> {
    return (await this.exchange(plan, call)).shaped;
  }

  /** Sends the request and shapes the response. deadline (epoch milliseconds) bounds every attempt. */
  private async exchange(plan: RequestPlan, call: Call, deadline?: number): Promise<{ shaped: Shaped; exchange: Exchange }> {
    const exchange = await performRequest(plan, deadline);
    if (call.raw) return { shaped: { data: decodeRaw(exchange, call.mutation, plan), meta: {} }, exchange };
    const shapeCall = this.shapeCall(call);
    return { shaped: shapeResponse(unwrap(exchange, shapeCall, plan), shapeCall, plan, exchange, this.context), exchange };
  }

  private preview(plan: MutationPlan, previews: RequestPlan[], access: Access): void {
    const requests = previews.map((item, index) => {
      const call = (plan.steps[index] as Step).call;
      const body = scrubDeep(call.previewBody !== undefined ? call.previewBody : redact(call.body), item);
      return {
        method: item.method,
        url: displayUrl(item),
        headers: { ...(redact(item.headers) as Record<string, string>), ...hiddenHeaders(item) },
        ...(body === undefined ? {} : { body }),
      };
    });
    printResult(
      {
        operation: this.name(),
        profile: reportedProfile(access),
        credential_source: credentialSource(access),
        requests,
        ...(plan.changes ? { changes: plan.changes.map(shownChange) } : {}),
      },
      { dry_run: true, validation: plan.validation ?? "local" },
    );
  }
}

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Hides every header the provider's authorize() produced, whatever its name. */
function hiddenHeaders(plan: RequestPlan): Record<string, string> {
  return Object.fromEntries(plan.credentialHeaders.map((name) => [name, REDACTED]));
}

/** Redacts a change by its field name, the way a request body is redacted. */
function shownChange(change: Change): ShownChange {
  const redacted = (value: unknown): unknown => (redact({ [change.field]: value }) as Record<string, unknown>)[change.field];
  return { field: change.field, before: redacted(change.before), after: redacted(change.after) };
}

function partialFailure(steps: Step[], results: Shaped[], index: number, failure: CliError): CliError {
  const failed = steps[index] as Step;
  const inner = failure.extra.partial;
  const nested = inner !== undefined && "completed" in inner ? inner : undefined;
  const earlier = results.map((result, position) => ({ step: (steps[position] as Step).name, result: result.data }));
  const later = steps.slice(index + 1).map((step) => ({ step: step.name }));
  const { cause: innerCause, ...innerDetails } = failure.extra.details ?? {};
  const partial: StepPartial = nested
    ? {
        completed: [...earlier, ...nested.completed],
        failed: nested.failed,
        not_attempted: [...nested.not_attempted, ...later],
      }
    : {
        completed: earlier,
        failed: [
          {
            step: failed.name,
            error: {
              code: failure.code,
              message: failure.message,
              ...(failure.extra.provider ? { provider: failure.extra.provider } : {}),
              ...(failure.extra.details ? { details: failure.extra.details } : {}),
            },
          },
        ],
        not_attempted: later,
      };
  const cause = nested ? ((innerCause as ErrorCode | undefined) ?? failure.code) : failure.code;
  return stepsFailure(partial, {
    cause,
    ...(nested && Object.keys(innerDetails).length > 0 ? { details: innerDetails } : {}),
    ...(failure.extra.outcome ? { outcome: failure.extra.outcome } : {}),
    ...(failure.extra.provider ? { provider: failure.extra.provider } : {}),
  });
}

/** True when an option that reads a file is set to - and so consumes stdin, which a confirmation prompt then must not read. */
export function stdinCarriesContent(context: Context): boolean {
  return context.spec.options.some((option) => option.type === "path" && context.options.string(option.name) === "-");
}
