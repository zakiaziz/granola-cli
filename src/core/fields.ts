// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import type { EndpointField, Provider } from "./provider.js";

/** apiVersion becomes api-version. */
export function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** apiVersion becomes API_VERSION. */
export function upperSnake(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
}

/** The environment variable of a field or setting: <BIN>_<KEY>, such as HUBSPOT_API_VERSION. */
export function variableName(provider: Provider, key: string): string {
  return `${provider.bin.toUpperCase()}_${upperSnake(key)}`;
}

export function endpointFields(provider: Provider): readonly EndpointField[] {
  return provider.endpointFields ?? [];
}

/** The field that chooses the base URL, such as a subdomain or region. */
export function derivingField(provider: Provider): EndpointField | undefined {
  return endpointFields(provider).find((field) => field.baseUrl !== undefined);
}

export function fieldPlaceholder(field: EndpointField): string {
  return field.placeholder ?? upperSnake(field.key);
}

export function fieldExample(field: EndpointField): string {
  return field.example ?? field.default ?? field.choices?.[0] ?? fieldPlaceholder(field);
}

/** Returns the failed constraint of a field value, or undefined when the value is valid. */
export function fieldConstraint(field: EndpointField, value: string): string | undefined {
  if (field.choices) return field.choices.includes(value) ? undefined : `be one of ${field.choices.join(", ")}`;
  return field.validate?.(value);
}

/** The base URL example for help and hints. */
export function baseUrlExample(provider: Provider): string {
  const { baseUrl } = provider;
  const field = derivingField(provider);
  const derived = field?.baseUrl?.(fieldExample(field));
  return baseUrl.example ?? baseUrl.default ?? derived ?? "https://example.com";
}
