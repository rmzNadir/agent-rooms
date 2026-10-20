import { Effect } from "effect";
import type { Json } from "effect/Schema";
import { at, isJsonObject, parseJson } from "../boundary/external.ts";

export const supportedProtocolVersions = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
] as const;

export type SupportedProtocolVersion =
  (typeof supportedProtocolVersions)[number];

export const protocolVersionMetaKey = "io.modelcontextprotocol/protocolVersion";

const modernVersion = "2026-07-28";

const isSupportedProtocolVersion = (
  value: string
): value is SupportedProtocolVersion =>
  (supportedProtocolVersions as readonly string[]).includes(value);

export const modernProtocolVersions = supportedProtocolVersions.filter(
  (version) => version === modernVersion
);

export interface VersionRejection {
  readonly id: string | number | null;
  readonly requested: string;
}

const idOf = (value: Json | undefined): string | number | null => {
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return null;
};

const textVersion = (value: Json | undefined): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const primitiveBody = (value: Json | undefined | symbol) =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

// A failed parse is a symbol. Reading fields from it finds no version, so the caller sees no rejection.
const malformedBody = Symbol("malformed");

const readBody = (bodyText: string) =>
  Effect.runSync(
    Effect.orElseSucceed(
      Effect.try(() => parseJson(bodyText)),
      () => malformedBody
    )
  );

const rejectionFrom = (
  parsed: { readonly [key: string]: Json },
  protocolHeader: string | null
): VersionRejection | undefined => {
  const paramsValue = at(parsed, "params");
  const params = isJsonObject(paramsValue) ? paramsValue : undefined;
  const metaValue = params === undefined ? undefined : at(params, "_meta");
  const meta = isJsonObject(metaValue) ? metaValue : undefined;
  const metaVersion =
    meta === undefined
      ? undefined
      : textVersion(at(meta, protocolVersionMetaKey));
  const method = at(parsed, "method");
  const initVersion =
    method === "initialize" && params !== undefined
      ? textVersion(at(params, "protocolVersion"))
      : undefined;
  const headerVersion =
    protocolHeader !== null && protocolHeader.length > 0
      ? protocolHeader
      : undefined;
  const requested = [headerVersion, metaVersion, initVersion].find(
    (version) => version !== undefined && !isSupportedProtocolVersion(version)
  );
  if (requested === undefined) {
    return undefined;
  }
  return { id: idOf(at(parsed, "id")), requested };
};

const rejectionIn = (
  parsed: Json | undefined | symbol,
  protocolHeader: string | null
): VersionRejection | undefined => {
  if (primitiveBody(parsed)) {
    return undefined;
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const rejection = isJsonObject(item)
        ? rejectionFrom(item, protocolHeader)
        : undefined;
      if (rejection !== undefined) {
        return rejection;
      }
    }
    return undefined;
  }
  return rejectionFrom(
    parsed as { readonly [column: string]: Json },
    protocolHeader
  );
};

export const versionRejection = (
  bodyText: string,
  protocolHeader: string | null
): VersionRejection | undefined =>
  rejectionIn(readBody(bodyText), protocolHeader);

export const unsupportedProtocolVersionBody = (
  rejection: VersionRejection
) => ({
  error: {
    code: -32_022,
    data: {
      requested: rejection.requested,
      supported: [...supportedProtocolVersions],
    },
    message: "Unsupported protocol version",
  },
  id: rejection.id,
  jsonrpc: "2.0" as const,
});
