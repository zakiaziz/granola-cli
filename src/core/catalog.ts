// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import type { Tool } from "./access.js";
import { ACCESS_KEY, ConfigStore } from "./config.js";
import { fieldSets, isPerRequest } from "./credentials.js";
import { CliError } from "./errors.js";
import { derivingField, endpointFields, fieldConstraint } from "./fields.js";
import type { Provider, ResourceCommand } from "./provider.js";
import { SAFE_METHODS } from "./types.js";
import { baseUrlConstraint } from "./values.js";
import { GLOBAL_OPTIONS, Registry, type ArgumentSpec } from "./registry.js";
import { localCommand, resourceCommand } from "./resources.js";
import { UTILITY_GROUP_SPECS, utilityCommands } from "./utilities.js";

/** Builds the full command registry: the shared utility commands plus the provider's resource commands. */
export function buildRegistry(provider: Provider): Registry {
  validateProvider(provider);
  const tool: Tool = { provider, store: new ConfigStore(provider) };
  const hasList = (path: readonly string[]): boolean => provider.commands.some((command) => command.path.join(" ") === path.join(" "));
  const commands = [
    ...utilityCommands(tool, () => registry),
    ...provider.commands.map((command) => resourceCommand(tool, command, hasList)),
    ...(provider.localCommands ?? []).map(localCommand),
  ];
  const registry: Registry = new Registry(provider.bin, commands, [...provider.groups, ...UTILITY_GROUP_SPECS]);
  return registry;
}

function fail(message: string): never {
  throw new CliError("UNEXPECTED_ERROR", message);
}

/** Rejects a provider definition the core cannot honor, so a mistake surfaces at startup and not in a request. */
function validateProvider(provider: Provider): void {
  validateEndpoint(provider);
  validateCredentials(provider);
  validateApi(provider);
  const paths = new Set<string>();
  for (const command of [...provider.commands, ...(provider.localCommands ?? [])]) {
    const path = command.path.join(" ");
    if (paths.has(path)) fail(`${path} is declared twice.`);
    paths.add(path);
    validateArguments(path, command.arguments);
  }
  for (const command of provider.commands) validateCommand(provider, command);
}

function validateEndpoint(provider: Provider): void {
  const { baseUrl } = provider;
  const fields = endpointFields(provider);
  const taken = new Set(["activeProfile", "baseUrl", "profile", ...provider.secrets.map((field) => field.key)]);
  if (provider.accessLevels && taken.has(ACCESS_KEY)) fail(`A credential field collides with the "${ACCESS_KEY}" profile key.`);
  if (provider.accessLevels) taken.add(ACCESS_KEY);
  if (baseUrl.joinPath && !baseUrl.allowPath) fail("baseUrl.joinPath requires baseUrl.allowPath.");
  for (const field of fields) {
    if (taken.has(field.key)) fail(`Endpoint field "${field.key}" collides with another key.`);
    taken.add(field.key);
    if (field.choices && field.validate) fail(`Endpoint field "${field.key}" declares both choices and validate.`);
  }
  if (fields.filter((field) => field.baseUrl).length > 1) fail("Only one endpoint field can derive the base URL.");
  if (baseUrl.default === undefined && baseUrl.example === undefined && derivingField(provider) === undefined) {
    fail("The base URL has no default, no example, and no endpoint field that derives it.");
  }
  const deriving = derivingField(provider);
  const derivedDefault = deriving?.default === undefined ? undefined : deriving.baseUrl?.(deriving.default);
  for (const [source, url] of [["default", baseUrl.default], ["derived default", derivedDefault], ["example", baseUrl.example]] as const) {
    const constraint = url === undefined ? undefined : baseUrlConstraint(url, baseUrl.allowPath);
    if (constraint) fail(`The base URL ${source} "${url}" must ${constraint}.`);
  }
  for (const field of fields) {
    if (field.default === undefined) continue;
    const constraint = fieldConstraint(field, field.default);
    if (constraint) fail(`The default of endpoint field "${field.key}" must ${constraint}.`);
  }
}

function validateCredentials(provider: Provider): void {
  const sets = fieldSets(provider);
  const keys = sets.flatMap((set) => set.fields.map((field) => field.key));
  if (new Set(keys).size !== keys.length) fail("A credential field belongs to more than one credential set.");
  if (new Set(sets.map((set) => set.name)).size !== sets.length) fail("Two credential sets share a name.");
  const unassigned = provider.secrets.find((field) => !keys.includes(field.key));
  if (unassigned) fail(`Credential field "${unassigned.key}" belongs to no credential set.`);
  if (isPerRequest(provider) && sets.length < 2) fail("credentialSets needs at least two credential sets.");
  if (provider.credentialSets && provider.credentialSets.some((set) => !/^[a-z][a-z0-9-]*$/.test(set.name))) {
    fail("Credential set names are lowercase kebab-case.");
  }
  if (sets.some((set) => set.fields.length === 0)) fail("A credential set has no fields.");
  validateCredentialOption(provider);
}

/** Keys of an auth verify result. The credential option's name, in snake case, leads each check of a verification of several. */
const VERIFY_KEYS = ["verified", "profile", "base_url", "checks", "check", "scope", "identity"];
const TAKEN_OPTIONS = ["query", "file", "yes", "dry-run", ...GLOBAL_OPTIONS.map((option) => option.name)];

function validateCredentialOption(provider: Provider): void {
  const option = provider.credentialOption;
  if (!option) return;
  if (!isPerRequest(provider)) fail("credentialOption needs credentialSets.");
  if (!/^[a-z][a-z0-9-]*$/.test(option.name)) fail(`credentialOption name "${option.name}" must be lowercase kebab-case.`);
  if (TAKEN_OPTIONS.includes(option.name)) fail(`credentialOption name "${option.name}" collides with another option.`);
  if (VERIFY_KEYS.includes(option.name.replaceAll("-", "_"))) fail(`credentialOption name "${option.name}" collides with a key of the auth verify result.`);
  if (!/^[A-Z][A-Z0-9_]*$/.test(option.placeholder)) fail(`credentialOption placeholder "${option.placeholder}" must be upper snake case.`);
  if (!/^[a-z][a-z ]*$/.test(option.noun)) fail(`credentialOption noun "${option.noun}" must be lowercase words.`);
}

function validateApi(provider: Provider): void {
  const { api } = provider;
  if (api.bodyCheck && api.methods.some((method) => SAFE_METHODS.includes(method))) {
    fail("api.bodyCheck requires every api method to change state.");
  }
  if (api.graphql && (api.methods.length !== 1 || api.methods[0] !== "POST")) fail('api.graphql requires api.methods to be ["POST"].');
  if (provider.protocol === "graphql" && !api.graphql) fail('A provider with protocol "graphql" must set api.graphql.');
  const checks = Array.isArray(provider.verify) ? provider.verify : [provider.verify];
  if (checks.length === 0) fail("The provider has no verify check.");
  if (isPerRequest(provider)) {
    const names = checks.map((check) => check.credential);
    if (names.some((name) => name === undefined)) fail("credentialSets needs a credential on every verify check.");
    if (new Set(names).size !== names.length) fail("Two verify checks use the same credential.");
  } else if (checks.length > 1) {
    fail("Several verify checks need credentialSets.");
  }
}

function validateArguments(path: string, args: readonly ArgumentSpec[]): void {
  args.forEach((argument, index) => {
    if (!argument.repeatable) return;
    if (index !== args.length - 1) fail(`${path} repeats argument ${argument.name}, which is not the last argument.`);
    if (argument.choices || argument.completion) fail(`${path} repeats argument ${argument.name} with choices or completion, which completions cannot offer for every value.`);
  });
}

function validateCommand(provider: Provider, command: ResourceCommand): void {
  const name = command.path.join(" ");
  const style = command.pagination?.style ?? provider.pagination;
  if (command.pagination && !style) fail(`${name} declares pagination, but neither it nor the provider has a pagination style.`);
  if (command.pagination?.window !== undefined && command.pagination.window < 1) fail(`${name} declares an empty pagination window.`);
  if (isPerRequest(provider) && command.credential === undefined) fail(`${name} must name its credential.`);
  if (!isPerRequest(provider) && command.credential !== undefined) fail(`${name} names a credential, but the provider declares no credentialSets.`);
  if (isPerRequest(provider) && !fieldSets(provider).some((set) => set.name === command.credential)) {
    fail(`${name} names credential "${command.credential}", which is not a credential set.`);
  }
  if (command.run) return;
  if (command.select && (command.collectionKey !== undefined || command.resourceKey !== undefined)) {
    fail(`${name} combines select with collectionKey or resourceKey.`);
  }
  if (command.collectionKey !== undefined && command.collection) fail(`${name} declares both collectionKey and collection.`);
  if (command.pagination && command.collectionKey === undefined && !command.collection) fail(`${name} paginates but declares no collection.`);
  if (command.pagination && command.settle) fail(`${name} combines pagination with settle.`);
  if (command.resourceKey !== undefined && (command.collectionKey !== undefined || command.collection)) {
    fail(`${name} combines resourceKey with a collection.`);
  }
}
