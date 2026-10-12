// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import type { Tool } from "./access.js";
import { Client, type Call } from "./client.js";
import { credentialNoun, setsFor } from "./credentials.js";
import { CliError } from "./errors.js";
import { printResult } from "./output.js";
import type { LocalCommand, RequestCommand, ResourceCommand, RunCommand } from "./provider.js";
import { DRY_RUN_OPTION, YES_OPTION, networkFailures, paginationOptions, type CommandSpec, type Context } from "./registry.js";
import { echoable } from "./values.js";

/** True when the registry has a list command at this path, so a hint can send the user to it. */
export type ListLookup = (path: readonly string[]) => boolean;

/** Turns a provider resource command into a registry command: options, failures, and dispatch come from its shape. */
export function resourceCommand(tool: Tool, command: ResourceCommand, hasList: ListLookup): CommandSpec {
  const mutation = command.effects.kind === "remote-mutation";
  const { pagination } = command;
  const style = pagination?.style ?? tool.provider.pagination;
  const partial =
    pagination !== undefined || command.run !== undefined || command.settle !== undefined || tool.provider.protocol === "graphql";
  return {
    path: command.path,
    summary: command.summary,
    arguments: command.arguments,
    options: [
      ...command.options,
      ...(pagination ? paginationOptions(pagination, style) : []),
      ...(mutation ? [YES_OPTION, DRY_RUN_OPTION] : []),
    ],
    kind: "network",
    effects: command.effects,
    ...(mutation && tool.provider.accessLevels ? { writeAccess: "always" as const } : {}),
    output: command.output,
    ...(pagination ? { pagination } : {}),
    ...(command.unpaginated ? { unpaginated: command.unpaginated } : {}),
    failures: networkFailures({
      identified: command.arguments.length > 0 || (command.run === undefined && command.emptyIsNotFound === true),
      partial,
      mutation,
      ...(command.failures ? { extra: command.failures } : {}),
    }),
    examples: command.examples,
    ...(command.exceptions ? { exceptions: command.exceptions } : {}),
    run: (context) => (command.run ? runCustom(tool, command, context) : runRequest(tool, command, context, hasList)),
  };
}

/** Turns a provider's reference command into a registry command that prints its data and sends nothing. */
export function localCommand(command: LocalCommand): CommandSpec {
  return {
    path: command.path,
    summary: command.summary,
    arguments: command.arguments,
    options: command.options,
    kind: "local",
    effects: { kind: "reference" },
    output: command.output,
    ...(command.unpaginated ? { unpaginated: command.unpaginated } : {}),
    failures: ["INVALID_ARGUMENT"],
    examples: command.examples,
    ...(command.exceptions ? { exceptions: command.exceptions } : {}),
    run: async (context) => {
      const result = await command.run(context);
      printResult(result.data, result.meta ?? {});
    },
  };
}

async function runCustom(tool: Tool, command: RunCommand, context: Context): Promise<void> {
  const client = new Client(tool, context, command.credential);
  if (command.effects.kind === "remote-mutation") client.assertWritable();
  const result = await command.run(context, client);
  if (result) printResult(result.data, client.meta(result.meta));
}

async function runRequest(tool: Tool, command: RequestCommand, context: Context, hasList: ListLookup): Promise<void> {
  const client = new Client(tool, context, command.credential);
  const request = command.request(context, client.endpoint);
  const mutation = command.effects.kind === "remote-mutation";
  const call: Call = {
    ...request,
    method: command.method,
    mutation,
    ...(command.credential === undefined ? {} : { credential: command.credential }),
    ...(command.collectionKey === undefined ? {} : { collectionKey: command.collectionKey }),
    ...(command.collection === undefined ? {} : { collection: command.collection }),
    ...(command.resourceKey === undefined ? {} : { resourceKey: command.resourceKey }),
    ...(command.providerMeta === undefined ? {} : { providerMeta: command.providerMeta }),
    ...(command.select === undefined ? {} : { select: command.select }),
    ...(command.settle === undefined ? {} : { settle: command.settle }),
  };
  const shaped = mutation
    ? await mutate(client, command, call, request.effect)
    : command.pagination
      ? await client.paginate(call)
      : await client.send(call);
  if (!shaped) return;
  if (command.emptyIsNotFound && isEmpty(shaped.data)) throw notFound(tool, command, context, hasList);
  printResult(shaped.data, client.meta(shaped.meta));
}

async function mutate(client: Client, command: RequestCommand, call: Call, effect: string | undefined) {
  const results = await client.mutate({
    effect: effect ?? command.effects.summary ?? command.summary,
    steps: [{ name: command.path.join(" "), call }],
    ...(command.effects.validation ? { validation: command.effects.validation } : {}),
  });
  return results?.[0];
}

function isEmpty(data: unknown): boolean {
  return data === null || (Array.isArray(data) && data.length === 0);
}

function notFound(tool: Tool, command: RequestCommand, context: Context, hasList: ListLookup): CliError {
  const { name, bin } = tool.provider;
  const target = context.args[0];
  if (target === undefined) {
    return new CliError("NOT_FOUND", `${name} returned no result for "${command.path.join(" ")}".`, {
      hint: `Check that the ${credentialNoun(tool.provider, setsFor(tool.provider, command.credential))} can access this resource.`,
    });
  }
  const group = command.path.slice(0, -1);
  return new CliError("NOT_FOUND", `${name} returned no result for ${echoable(target)}.`, {
    hint: hasList([...group, "list"])
      ? `Run '${[bin, ...group, "list"].join(" ")}' to find valid IDs.`
      : `Check that the identifier is correct and that the ${credentialNoun(tool.provider, setsFor(tool.provider, command.credential))} can access it.`,
  });
}
