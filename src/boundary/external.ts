import { Schema } from "effect";
import type { Json } from "effect/Schema";

/**
 * The only module allowed to name `unknown`.
 *
 * TypeScript types `catch` bindings and `JSON.parse` as `unknown` or `any`.
 * Effect's `Schema.Unknown` and `decodeUnknown*` accept that library input.
 * Callers pass decoded JSON or typed values and never write those types.
 */
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const environment = process.env;

export const readEnv = (name: string): string | undefined => environment[name];

export const writeEnv = (name: string, value: string): void => {
  environment[name] = value;
};

export const fillEnv = (name: string, value: string): void => {
  if (environment[name] === undefined) {
    environment[name] = value;
  }
};

export const isJsonObject = (
  value: Json | undefined
): value is { readonly [key: string]: Json } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const at = <Value>(
  value: { readonly [column: string]: Value },
  key: string
): Value | undefined => value[key];

export const setAt = <Value>(
  value: { [column: string]: Value },
  key: string,
  next: Value
): void => {
  value[key] = next;
};

export const parseJson = (text: string): Json => decodeJson(text);

export const encodeJsonText = <A>(value: A) => encodeJson(value);

export const causeMessage = (error: Error | string): string =>
  error instanceof Error ? error.message : error;
