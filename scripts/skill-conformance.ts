import type { Client } from "@modelcontextprotocol/client";
import type { Json } from "effect/Schema";
import { at, isJsonObject, parseJson } from "../src/boundary/external.ts";
import { skillMarkdown } from "../src/mcp/guide.ts";
import { protocolVersionMetaKey } from "../src/mcp/protocol.ts";
import { skillUri } from "../src/mcp/skill-catalog.ts";

export interface SkillTarget {
  readonly token: string;
  readonly url: string;
}

function fail(version: string, detail: string): never {
  throw new Error(`${version}: ${detail}`);
}

export const postJson = async (
  url: string,
  headers: Record<string, string>,
  body: Json
) => {
  const init = {
    body: JSON.stringify(body),
    headers: { connection: "close", ...headers },
    method: "POST",
  };
  try {
    return await fetch(url, init);
  } catch (error) {
    if (!(error instanceof Error && error.message.includes("ECONNRESET"))) {
      throw error;
    }
    return await fetch(url, init);
  }
};

export const readJson = async (response: Response) => {
  const text = await response.text();
  try {
    return parseJson(text);
  } catch (error) {
    throw new Error(text, { cause: error });
  }
};

const digestHex = async (text: string) => {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  );
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const modernMeta = {
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": {
    name: "conformance",
    version: "0",
  },
  [protocolVersionMetaKey]: "2026-07-28",
};

const rpc = (
  modern: boolean,
  id: number,
  method: string,
  params: { readonly [key: string]: Json }
) => ({
  id,
  jsonrpc: "2.0" as const,
  method,
  params: modern ? { ...params, _meta: modernMeta } : params,
});

const protocolHeaders = (modern: boolean, method: string) =>
  modern
    ? {
        "mcp-method": method,
        "mcp-protocol-version": "2026-07-28",
      }
    : { "mcp-protocol-version": "2025-06-18" };

const nameHeader = (method: string, uri: Json | undefined) => {
  if (method !== "resources/read" || typeof uri !== "string") {
    return {};
  }
  return { "mcp-name": uri };
};

const skillHeaders = (
  target: SkillTarget,
  modern: boolean,
  method: string,
  params: { readonly [key: string]: Json }
) => ({
  accept: "application/json, text/event-stream",
  authorization: `Bearer ${target.token}`,
  "content-type": "application/json",
  ...protocolHeaders(modern, method),
  ...(modern ? nameHeader(method, at(params, "uri")) : {}),
});

const postRpc = (
  target: SkillTarget,
  modern: boolean,
  id: number,
  method: string,
  params: { readonly [key: string]: Json }
) =>
  postJson(
    target.url,
    skillHeaders(target, modern, method, params),
    rpc(modern, id, method, params)
  ).then(readJson);

const resultOf = (version: string, parsed: Json) => {
  if (!isJsonObject(parsed)) {
    fail(version, "skill response was not an object");
  }
  const result = at(parsed, "result");
  if (!isJsonObject(result)) {
    fail(version, "skill response had no result");
  }
  return result;
};

const firstContent = (
  version: string,
  result: { readonly [key: string]: Json }
) => {
  const contents = at(result, "contents");
  if (!Array.isArray(contents) || contents.length === 0) {
    fail(version, "skill read had no contents");
  }
  const [first] = contents;
  if (!isJsonObject(first)) {
    fail(version, "skill read content was not an object");
  }
  return first;
};

const skillText = (
  version: string,
  result: { readonly [key: string]: Json }
) => {
  const text = at(firstContent(version, result), "text");
  if (typeof text !== "string") {
    fail(version, "skill read had no text");
  }
  return text;
};

const onlySkill = (version: string, skills: Json | undefined) => {
  if (!Array.isArray(skills) || skills.length !== 1) {
    fail(version, "skills/list did not return one skill");
  }
  const [skill] = skills;
  if (!isJsonObject(skill)) {
    fail(version, "skills/list entry was not an object");
  }
  return skill;
};

const manifestResource = (
  version: string,
  skill: { readonly [key: string]: Json }
) => {
  const resources = at(skill, "resources");
  if (!Array.isArray(resources) || resources.length !== 1) {
    fail(version, "skill manifest was not one file");
  }
  const [file] = resources;
  if (!isJsonObject(file)) {
    fail(version, "skill file was not an object");
  }
  return file;
};

const assertSkillUri = (
  version: string,
  skill: { readonly [key: string]: Json }
) => {
  if (at(skill, "uri") !== skillUri) {
    fail(version, "skill uri differed");
  }
};

const assertDigest = async (
  version: string,
  text: string,
  file: { readonly [key: string]: Json }
) => {
  if (at(file, "digest") !== `sha256:${await digestHex(text)}`) {
    fail(version, `digest ${String(at(file, "digest"))}`);
  }
  if (at(file, "size") !== new TextEncoder().encode(text).byteLength) {
    fail(version, `size ${String(at(file, "size"))}`);
  }
};

const assertFresh = (
  version: string,
  result: { readonly [key: string]: Json }
) => {
  if (at(result, "resultType") !== "complete") {
    fail(version, "resultType was not complete");
  }
  if (at(result, "ttlMs") !== 300_000) {
    fail(version, "ttlMs differed");
  }
  if (at(result, "cacheScope") !== "public") {
    fail(version, "cacheScope differed");
  }
};

const assertCache = (
  version: string,
  modern: boolean,
  result: { readonly [key: string]: Json }
) => {
  if (modern) {
    assertFresh(version, result);
  }
};

const assertSkillBytes = async (
  target: SkillTarget,
  modern: boolean,
  version: string
) => {
  const read = resultOf(
    version,
    await postRpc(target, modern, 5, "resources/read", { uri: skillUri })
  );
  const text = skillText(version, read);
  if (text !== skillMarkdown()) {
    fail(version, "skill bytes differed from the guide");
  }
  const got = resultOf(
    version,
    await postRpc(target, modern, 6, "skills/get", { uri: skillUri })
  );
  const skill = at(got, "skill");
  if (!isJsonObject(skill)) {
    fail(version, "skills/get had no skill");
  }
  assertSkillUri(version, skill);
  await assertDigest(version, text, manifestResource(version, skill));
  const listed = resultOf(
    version,
    await postRpc(target, modern, 7, "skills/list", {})
  );
  assertSkillUri(version, onlySkill(version, at(listed, "skills")));
  assertCache(version, modern, listed);
  assertCache(version, modern, got);
};

const errorCode = (version: string, parsed: Json) => {
  if (!isJsonObject(parsed)) {
    fail(version, "skill error was not an object");
  }
  const rpcError = at(parsed, "error");
  if (!isJsonObject(rpcError)) {
    fail(version, "skill error had no data");
  }
  return at(rpcError, "code");
};

const assertUnknownSkill = async (
  target: SkillTarget,
  modern: boolean,
  version: string
) => {
  const parsed = await postRpc(target, modern, 8, "skills/get", {
    uri: "skill://missing/SKILL.md",
  });
  const code = errorCode(version, parsed);
  if (code !== -32_602) {
    fail(version, `missing skill returned ${String(code)}`);
  }
};

const assertNoDirectoryRead = async (
  target: SkillTarget,
  modern: boolean,
  version: string
) => {
  const parsed = await postRpc(target, modern, 9, "resources/directory/read", {
    uri: "skill://agent-rooms",
  });
  const code = errorCode(version, parsed);
  if (code !== -32_601) {
    fail(version, `directory read returned ${String(code)}`);
  }
};

const assertDiscoverExtension = (client: Client, version: string) => {
  const capabilities = client.getDiscoverResult()?.capabilities;
  const extension =
    capabilities?.extensions?.["io.modelcontextprotocol/skills"];
  if (extension === undefined || Object.keys(extension).length !== 0) {
    fail(version, "skills extension was not the empty object");
  }
  if (capabilities?.resources === undefined) {
    fail(version, "discover omitted resources");
  }
};

const assertLegacyResources = (client: Client, version: string) => {
  const capabilities = client.getServerCapabilities();
  if (capabilities === undefined || capabilities.resources === undefined) {
    fail(version, "initialize omitted resources");
  }
  if (capabilities.extensions !== undefined) {
    fail(version, "initialize advertised extensions");
  }
};

const assertAdvertised = (client: Client, modern: boolean, version: string) => {
  if (modern) {
    assertDiscoverExtension(client, version);
    return;
  }
  assertLegacyResources(client, version);
};

export const assertSkills = async (
  client: Client,
  target: SkillTarget,
  modern: boolean,
  version: string
) => {
  await assertSkillBytes(target, modern, version);
  await assertUnknownSkill(target, modern, version);
  await assertNoDirectoryRead(target, modern, version);
  assertAdvertised(client, modern, version);
};
