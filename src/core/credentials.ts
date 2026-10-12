// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { CliError } from "./errors.js";
import { variableName } from "./fields.js";
import type { Provider, SecretField } from "./provider.js";
import { listWords } from "./values.js";

/** A set of credential fields that travel together. */
export interface FieldSet {
  name: string;
  fields: SecretField[];
}

export interface Credential {
  /** Field values. A first-complete provider holds one complete set. A per-request provider holds every field supplied. */
  values: Record<string, string>;
  source: "environment" | "profile";
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

export function isPerRequest(provider: Provider): boolean {
  return provider.credentialSelection === "per-request";
}

export function setLabel(set: FieldSet): string {
  return set.fields.map((field) => field.label).join(" and ");
}

export function setVariables(provider: Provider, set: FieldSet): string {
  return set.fields.map((field) => variableName(provider, field.key)).join(" and ");
}

/** The credential noun for help and errors: every set's label, joined by "or". */
export function credentialNoun(provider: Provider, sets: readonly FieldSet[] = fieldSets(provider)): string {
  return sets.map(setLabel).join(" or ");
}

/** The variables that supply a credential: every set's variables, joined by "or". */
export function credentialVariables(provider: Provider, sets: readonly FieldSet[] = fieldSets(provider)): string {
  return sets.map((set) => setVariables(provider, set)).join(", or ");
}

/** How a source reports an incomplete set, and fields that come from more than one set. */
export interface SourceText {
  incomplete(set: FieldSet, missing: SecretField[]): CliError;
  /** supplied lists the supplied fields of each set that has any, in set order. */
  mixed(supplied: readonly SecretField[][]): CliError;
}

function isSupplied(supplied: Readonly<Record<string, string | undefined>>, field: SecretField): boolean {
  return supplied[field.key] !== undefined;
}

/**
 * Picks the credential a source supplies (STYLE-CFG-2). A source that supplies any field is the source. First-complete
 * providers take the one complete set the source supplies, and fail when the source supplies fields of more than one
 * set (the source says which) or when its set is incomplete. Per-request providers keep every supplied field, and the
 * request that names a set checks it.
 */
export function credentialFrom(
  provider: Provider,
  supplied: Readonly<Record<string, string | undefined>>,
  source: Credential["source"],
  text: SourceText,
): Credential | undefined {
  const sets = fieldSets(provider);
  if (!sets.some((set) => set.fields.some((field) => isSupplied(supplied, field)))) return undefined;
  if (isPerRequest(provider)) return { values: definedValues(provider.secrets, supplied), source };
  const supplying = sets.filter((set) => set.fields.some((field) => isSupplied(supplied, field)));
  if (supplying.length > 1) throw text.mixed(supplying.map((set) => set.fields.filter((field) => isSupplied(supplied, field))));
  const set = supplying[0];
  if (!set) return undefined;
  const missing = set.fields.filter((field) => !isSupplied(supplied, field));
  if (missing.length > 0) throw text.incomplete(set, missing);
  return { values: definedValues(set.fields, supplied), source };
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
 * The credential a request sends, or undefined when none is available. A first-complete credential is already one
 * set. A per-request credential narrows to the named set, which must be complete.
 */
export function credentialFor(provider: Provider, credential: Credential | undefined, setName: string | undefined): Credential | undefined {
  if (!credential || !isPerRequest(provider)) return credential;
  const set = requestedSet(provider, setName);
  if (!set.fields.every((field) => credential.values[field.key] !== undefined)) return undefined;
  return { ...credential, values: definedValues(set.fields, credential.values) };
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
