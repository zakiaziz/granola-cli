// Vendored from cli-core. Do not edit here; change cli-core and run its sync script.
import { readGraphql } from "./graphql.js";
import { decodeJson, invalidResponse, type Exchange, type RequestPlan } from "./http.js";
import type { ResponseShape } from "./provider.js";
import type { Context } from "./registry.js";
import { isRecord } from "./values.js";

/** A response shape with the facts the core needs to name and classify failures. */
export interface ShapeCall extends ResponseShape {
  /** Command name for messages. */
  name: string;
  /** GraphQL root field the request reads. */
  field?: string | undefined;
  mutation: boolean;
}

export interface Shaped {
  data: unknown;
  meta: Record<string, unknown>;
}

/** A decoded response. input is what select receives, root is the value the shape reads when select is absent. */
export interface Unwrapped {
  /** The decoded JSON body. */
  body: unknown;
  /** The decoded body, or the GraphQL data object. */
  input: unknown;
  /** The decoded body, or the GraphQL root field value. */
  root: unknown;
}

/** Decodes a response body. A GraphQL provider also gets its errors, partial data, and root field handled. */
export function unwrap(exchange: Exchange, call: ShapeCall, plan: RequestPlan): Unwrapped {
  const body = decodeJson(exchange, call.mutation, plan);
  if (plan.provider.protocol !== "graphql") return { body, input: body, root: body };
  const graphql = readGraphql(body, call, plan, exchange);
  return { body, input: graphql.data, root: graphql.root };
}

export function isCollection(call: ResponseShape): boolean {
  return call.collectionKey !== undefined || call.collection === true;
}

function choose(unwrapped: Unwrapped, call: ShapeCall, context: Context): unknown {
  if (!call.select) return unwrapped.root;
  return call.select(unwrapped.input, context) ?? null;
}

/** Takes the collection out of one response. container is what Pagination.read receives as its payload. */
export function collectionOf(
  unwrapped: Unwrapped,
  call: ShapeCall,
  plan: RequestPlan,
  exchange: Exchange,
  context: Context,
): { items: unknown[]; container: unknown } {
  const base = choose(unwrapped, call, context);
  const key = call.collectionKey;
  if (key !== undefined) {
    const items = isRecord(base) && Object.hasOwn(base, key) ? base[key] : undefined;
    if (Array.isArray(items)) return { items, container: base };
    throw invalidResponse(plan, `${plan.provider.name} returned no "${key}" array for ${call.name}.`, exchange, call.mutation);
  }
  if (Array.isArray(base)) return { items: base, container: call.select ? unwrapped.input : base };
  throw invalidResponse(plan, `${plan.provider.name} returned no collection array for ${call.name}.`, exchange, call.mutation);
}

/** Shapes the response of a command that sends one response: a resource, an unpaginated collection, or a raw selection. */
export function shapeResponse(unwrapped: Unwrapped, call: ShapeCall, plan: RequestPlan, exchange: Exchange, context: Context): Shaped {
  const collection = isCollection(call);
  const { value, container } = collection
    ? valueOfCollection(unwrapped, call, plan, exchange, context)
    : valueOfResource(unwrapped, call, plan, exchange, context);
  const data = call.settle ? (call.settle({ data: value, payload: unwrapped.body }, context) ?? null) : value;
  return { data, meta: providerMeta(call.select ? unwrapped.input : container, call.providerMeta) };
}

function valueOfCollection(
  unwrapped: Unwrapped,
  call: ShapeCall,
  plan: RequestPlan,
  exchange: Exchange,
  context: Context,
): { value: unknown; container: unknown } {
  const { items, container } = collectionOf(unwrapped, call, plan, exchange, context);
  return { value: items, container };
}

function valueOfResource(
  unwrapped: Unwrapped,
  call: ShapeCall,
  plan: RequestPlan,
  exchange: Exchange,
  context: Context,
): { value: unknown; container: unknown } {
  const base = choose(unwrapped, call, context);
  const key = call.resourceKey;
  let value = base;
  if (key !== undefined) {
    if (!isRecord(base) || !Object.hasOwn(base, key)) {
      throw invalidResponse(plan, `${plan.provider.name} returned no "${key}" result for ${call.name}.`, exchange, call.mutation);
    }
    value = base[key];
  }
  if (value !== null && typeof value !== "object") {
    throw invalidResponse(plan, `${plan.provider.name} returned a non-object result for ${call.name}.`, exchange, call.mutation);
  }
  return { value, container: base };
}

function providerMeta(container: unknown, keys: readonly string[] | undefined): Record<string, unknown> {
  if (!keys || !isRecord(container)) return {};
  const found = Object.fromEntries(keys.filter((key) => Object.hasOwn(container, key)).map((key) => [key, container[key]]));
  return Object.keys(found).length > 0 ? { provider: found } : {};
}
