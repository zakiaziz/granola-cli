// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { CliError } from "./errors.js";
import { kebab, upperSnake } from "./fields.js";
import type { Provider, SecretField } from "./provider.js";
import { listWords } from "./values.js";

/** A set of credential fields that travel together. */
export interface FieldSet {
  name: string;
  fields: SecretField[];
}

/** The credential fields a profile stores. */
export interface Credential {
  /** Field values. A single-set provider holds one complete set. A per-request provider holds every field stored. */
  values: Record<string, string>;
}

export function isSecret(field: SecretField): boolean {
  return field.secret !== false;
}

export function fieldSets(provider: Provider): FieldSet[] {
  if (!provider.credentialSets) return [{ name: "credential", fields: provider.secrets }];
  return provider.credentialSets.map((set) => ({
    name: set.name,
    fields: set.fields.map((key) => {
      const field = provider.secrets.find((candidate) => candidate.key === key);
      if (!field) throw new CliError("UNEXPECTED_ERROR", `Credential set "${set.name}" names unknown field "${key}".`);
      return field;
    }),
  }));
}

/** True when the provider declares credential sets: each command or check names the one it needs. */
export function isPerRequest(provider: Provider): boolean {
  return provider.credentialSets !== undefined;
}

export function setLabel(set: FieldSet): string {
  return set.fields.map((field) => field.label).join(" and ");
}

/** The credential noun for help and errors: every set's label, joined by "or". */
export function credentialNoun(provider: Provider, sets: readonly FieldSet[] = fieldSets(provider)): string {
  return sets.map(setLabel).join(" or ");
}

/** The option that stores a field: --api-key-file PATH for a secret, --email EMAIL for a field that is not secret. */
export function fieldOption(field: SecretField): { name: string; placeholder: string } {
  return isSecret(field)
    ? { name: `${kebab(field.key)}-file`, placeholder: "PATH" }
    : { name: kebab(field.key), placeholder: field.placeholder ?? upperSnake(field.key) };
}

/** The options that store every field of the sets, as `--name PLACEHOLDER` words joined by the given word. */
export function credentialOptionsText(sets: readonly FieldSet[], join: "and" | "or" = "and"): string {
  return listWords(
    sets.flatMap((set) => set.fields.map((field) => {
      const option = fieldOption(field);
      return `--${option.name} ${option.placeholder}`;
    })),
    join,
  );
}

function definedValues(fields: readonly SecretField[], supplied: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = supplied[field.key];
    if (value !== undefined) values[field.key] = value;
  }
  return values;
}

/**
 * The credential a profile stores, or undefined when it stores none. A single-set provider needs the complete set and
 * throws incomplete for a partial one. A per-request provider keeps every stored field, and the request that names a
 * set checks it.
 */
export function credentialFrom(
  provider: Provider,
  stored: Readonly<Record<string, string | undefined>>,
  incomplete: (set: FieldSet, missing: SecretField[]) => CliError,
): Credential | undefined {
  const sets = fieldSets(provider);
  if (!sets.some((set) => set.fields.some((field) => stored[field.key] !== undefined))) return undefined;
  if (isPerRequest(provider)) return { values: definedValues(provider.secrets, stored) };
  const [set] = sets;
  if (!set) return undefined;
  const missing = set.fields.filter((field) => stored[field.key] === undefined);
  if (missing.length > 0) throw incomplete(set, missing);
  return { values: definedValues(set.fields, stored) };
}

/**
 * The credential a request sends, or undefined when none is available. A single-set credential is already one set. A
 * per-request credential narrows to the named set, which must be complete.
 */
export function credentialFor(provider: Provider, credential: Credential | undefined, setName: string | undefined): Credential | undefined {
  if (!credential || !isPerRequest(provider)) return credential;
  const set = requestedSet(provider, setName);
  if (!set.fields.every((field) => credential.values[field.key] !== undefined)) return undefined;
  return { values: definedValues(set.fields, credential.values) };
}

export function requestedSet(provider: Provider, setName: string | undefined): FieldSet {
  const sets = fieldSets(provider);
  const set = sets.find((candidate) => candidate.name === setName);
  if (set) return set;
  throw new CliError("UNEXPECTED_ERROR", `The request names credential "${setName ?? ""}", which is not one of ${listWords(sets.map((item) => item.name), "or")}.`);
}

/** The sets a request can use, for messages. */
export function setsFor(provider: Provider, setName: string | undefined): FieldSet[] {
  return isPerRequest(provider) ? [requestedSet(provider, setName)] : fieldSets(provider);
}
