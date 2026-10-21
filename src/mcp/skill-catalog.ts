import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type StandardSchemaV1,
} from "@modelcontextprotocol/server";
import type { Json } from "effect/Schema";
import { at } from "../boundary/external.ts";
import {
  agentInstructions,
  skillDescription,
  skillMarkdown,
  skillName,
} from "./guide.ts";

const skillText = skillMarkdown();
const skillBytes = new TextEncoder().encode(skillText);

export const skillUri = `skill://${skillName}/SKILL.md`;

export const skillCache = {
  cacheScope: "public" as const,
  ttlMs: 300_000,
};

export const serverInstructions = `${agentInstructions} Read ${skillUri} for the full guide.`;

const bytesOf = (payload: Uint8Array) => {
  const copy = new ArrayBuffer(payload.byteLength);
  new Uint8Array(copy).set(payload);
  return copy;
};

const sha256 = async (payload: Uint8Array) => {
  const hash = await crypto.subtle.digest("SHA-256", bytesOf(payload));
  const hex = [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
};

const skillEntry = async () => ({
  frontmatter: {
    description: skillDescription,
    name: skillName,
  },
  resources: [
    {
      digest: await sha256(skillBytes),
      size: skillBytes.byteLength,
      uri: skillUri,
    },
  ],
  uri: skillUri,
});

const cached = <Body extends object>(body: Body) => ({
  ...body,
  cacheScope: skillCache.cacheScope,
  resultType: "complete" as const,
  ttlMs: skillCache.ttlMs,
});

const paramsSchema: StandardSchemaV1<{ readonly [key: string]: Json }> = {
  "~standard": {
    validate(value) {
      return { value: value as { readonly [key: string]: Json } };
    },
    vendor: skillName,
    version: 1,
  },
};

const fresh = <Body extends object>(body: Body, modern: boolean) => {
  if (modern) {
    return cached(body);
  }
  return body;
};

const listSkills = (modern: boolean) => async () =>
  fresh({ skills: [await skillEntry()] }, modern);

const getSkill =
  (modern: boolean) => async (params: { readonly [key: string]: Json }) => {
    if (at(params, "uri") !== skillUri) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown skill");
    }
    return fresh({ skill: await skillEntry() }, modern);
  };

const readSkill = async (uri: URL) => ({
  contents: [
    {
      mimeType: "text/markdown",
      text: skillText,
      uri: uri.href,
    },
  ],
});

export const registerSkills = (server: McpServer, modern: boolean) => {
  server.registerResource(
    skillName,
    skillUri,
    {
      cacheHint: skillCache,
      description: skillDescription,
      mimeType: "text/markdown",
    },
    readSkill
  );
  server.server.setRequestHandler(
    "skills/list",
    { params: paramsSchema },
    listSkills(modern)
  );
  server.server.setRequestHandler(
    "skills/get",
    { params: paramsSchema },
    getSkill(modern)
  );
};
