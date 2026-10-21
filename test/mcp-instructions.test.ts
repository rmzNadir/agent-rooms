import { describe, expect, test } from "bun:test";
import { Context, Effect, Schema } from "effect";
import type { Json } from "effect/Schema";
import { readJson } from "../scripts/skill-conformance.ts";
import { Chat } from "../src/app/chat.ts";
import { at, isJsonObject, parseJson } from "../src/boundary/external.ts";
import { Actor } from "../src/domain/actor.ts";
import { AgentId } from "../src/domain/ids.ts";
import { IdentityView } from "../src/domain/message.ts";
import { agentInstructions, skillMarkdown } from "../src/mcp/guide.ts";
import { serveMcp } from "../src/mcp/handler.ts";
import { protocolVersionMetaKey } from "../src/mcp/protocol.ts";
import { serverInstructions, skillUri } from "../src/mcp/skill-catalog.ts";

const agentId = Schema.decodeUnknownSync(AgentId)(
  "agent_aaaaaaaaaaaaaaaaaaaaaaaa"
);
const actor = new Actor({
  admin: false,
  agentId,
  displayName: "ada",
  kind: "agent",
});
const unavailable = () => Effect.die("This test only calls whoami.");
const services = Context.make(Chat, {
  createAgent: unavailable,
  createRoom: unavailable,
  editMessage: unavailable,
  forward: unavailable,
  getUnread: unavailable,
  invite: unavailable,
  join: unavailable,
  leave: unavailable,
  listAgents: unavailable,
  listRooms: unavailable,
  listThreads: unavailable,
  markRead: unavailable,
  members: unavailable,
  postMessage: unavailable,
  react: unavailable,
  readMessages: unavailable,
  readTranscript: unavailable,
  redactMessage: unavailable,
  registerWebhook: unavailable,
  releaseRoom: unavailable,
  resolve: unavailable,
  retireAgent: unavailable,
  rotateToken: unavailable,
  searchMessages: unavailable,
  waitForMessages: unavailable,
  whoami: () =>
    new IdentityView({
      admin: false,
      agentId,
      displayName: "ada",
      kind: "agent",
    }),
});

const post = (body: Json, headers: Record<string, string>) =>
  serveMcp(
    new Request("http://localhost/mcp", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
      method: "POST",
    }),
    actor,
    services
  );

describe("mcp instructions", () => {
  test("initialize returns the guide", async () => {
    const response = await post(
      {
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
          protocolVersion: "2025-06-18",
        },
      },
      { "mcp-protocol-version": "2025-06-18" }
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(agentInstructions);
  });

  test("a bad room id is the public error envelope", async () => {
    const response = await post(
      {
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { body: "hi", mentions: ["ada"], room: "nope" },
          name: "post_message",
        },
      },
      { "mcp-protocol-version": "2025-06-18" }
    );
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("InvalidArgument");
    expect(text).toContain("requestId");
  });

  test("a dropped protocol version in a batch is rejected", async () => {
    const response = await post(
      [
        {
          id: 4,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
            protocolVersion: "2025-03-26",
          },
        },
      ],
      { "mcp-protocol-version": "2025-03-26" }
    );
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(text).toContain("-32022");
    expect(text).toContain("2026-07-28");
  });

  test("server/discover returns the guide", async () => {
    const response = await post(
      {
        id: 1,
        jsonrpc: "2.0",
        method: "server/discover",
        params: {
          _meta: {
            [protocolVersionMetaKey]: "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "test",
              version: "0",
            },
          },
        },
      },
      { "mcp-method": "server/discover", "mcp-protocol-version": "2026-07-28" }
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(agentInstructions);
  });
});

const digestOf = async (text: string) => {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  );
  const hex = [...hash]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
};

const parsed = async (response: Response) => parseJson(await response.text());

const resultOf = (value: Json) => {
  if (!isJsonObject(value)) {
    throw new Error("response was not an object");
  }
  const result = at(value, "result");
  if (!isJsonObject(result)) {
    throw new Error("response had no result");
  }
  return result;
};

const errorField = (value: Json, name: string) => {
  if (!isJsonObject(value)) {
    return;
  }
  const error = at(value, "error");
  if (!isJsonObject(error)) {
    return;
  }
  return at(error, name);
};

const codeOf = (value: Json) => errorField(value, "code");

const messageOf = (value: Json) => errorField(value, "message");

const contentOf = (result: { readonly [key: string]: Json }) => {
  const contents = at(result, "contents");
  if (!(Array.isArray(contents) && isJsonObject(contents[0]))) {
    throw new Error("resource had no contents");
  }
  return contents[0];
};

const textOf = (result: { readonly [key: string]: Json }) => {
  const text = at(contentOf(result), "text");
  if (typeof text !== "string") {
    throw new Error("resource had no text");
  }
  return text;
};

const mimeOf = (result: { readonly [key: string]: Json }) =>
  at(contentOf(result), "mimeType");

const fileOf = (skill: { readonly [key: string]: Json }) => {
  const resources = at(skill, "resources");
  if (!(Array.isArray(resources) && isJsonObject(resources[0]))) {
    throw new Error("skill had no file");
  }
  return resources[0];
};

const legacy = (id: number, method: string, params: Json) =>
  post(
    { id, jsonrpc: "2.0", method, params },
    { "mcp-protocol-version": "2025-06-18" }
  );

const modernHeaders = (method: string, params: Json) => {
  const uri = isJsonObject(params) ? at(params, "uri") : undefined;
  const headers = {
    "mcp-method": method,
    "mcp-protocol-version": "2026-07-28",
  };
  if (method === "resources/read" && typeof uri === "string") {
    return { ...headers, "mcp-name": uri };
  }
  return headers;
};

const modernParams = (params: Json) => ({
  ...(isJsonObject(params) ? params : {}),
  _meta: {
    [protocolVersionMetaKey]: "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": {
      name: "test",
      version: "0",
    },
  },
});

const modern = (id: number, method: string, params: Json) =>
  post(
    {
      id,
      jsonrpc: "2.0",
      method,
      params: modernParams(params),
    },
    modernHeaders(method, params)
  );

const recordField = (value: Json | undefined, name: string) => {
  if (!isJsonObject(value)) {
    return;
  }
  return at(value, name);
};

const manifestOf = async (
  skill: { readonly [key: string]: Json },
  text: string
) => {
  const file = fileOf(skill);
  return {
    description: recordField(at(skill, "frontmatter"), "description"),
    digest: at(file, "digest"),
    expectedDigest: await digestOf(text),
    fileUri: at(file, "uri"),
    name: recordField(at(skill, "frontmatter"), "name"),
    size: at(file, "size"),
    textSize: new TextEncoder().encode(text).byteLength,
    uri: at(skill, "uri"),
  };
};

describe("mcp skills", () => {
  test("a streamed skill response is one json body", async () => {
    const body =
      'event: message\ndata: {"result":{"uri":"skill://agent-rooms/SKILL.md"}}\n\n';
    const framed = await readJson(new Response(body));
    expect(at(resultOf(framed), "uri")).toBe(skillUri);
  });

  test("a 2025 client reads the skill as a resource", async () => {
    const initialized = resultOf(
      await parsed(
        await legacy(1, "initialize", {
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
          protocolVersion: "2025-06-18",
        })
      )
    );
    expect(at(initialized, "capabilities")).toEqual({
      resources: { listChanged: false },
      tools: { listChanged: false },
    });
    expect(at(initialized, "instructions")).toBe(serverInstructions);
    const read = resultOf(
      await parsed(await legacy(2, "resources/read", { uri: skillUri }))
    );
    const text = textOf(read);
    expect(mimeOf(read)).toBe("text/markdown");
    const file = await Bun.file(
      new URL("../skills/agent-rooms/SKILL.md", import.meta.url)
    ).text();
    expect(text).toBe(file);
    expect(text).toBe(skillMarkdown());
    const listed = resultOf(
      await parsed(await legacy(3, "resources/list", {}))
    );
    const resources = at(listed, "resources");
    expect(Array.isArray(resources)).toBe(true);
    expect(resources).toEqual([
      {
        description:
          "Use when you are a member of an agent-rooms project room and need to read the room, post, or coordinate the work.",
        mimeType: "text/markdown",
        name: "agent-rooms",
        uri: skillUri,
      },
    ]);
    const got = resultOf(
      await parsed(await legacy(4, "skills/get", { uri: skillUri }))
    );
    const skill = at(got, "skill");
    if (!isJsonObject(skill)) {
      throw new Error("skills/get had no skill");
    }
    expect(await manifestOf(skill, text)).toEqual({
      description:
        "Use when you are a member of an agent-rooms project room and need to read the room, post, or coordinate the work.",
      digest: await digestOf(text),
      expectedDigest: await digestOf(text),
      fileUri: skillUri,
      name: "agent-rooms",
      size: new TextEncoder().encode(text).byteLength,
      textSize: new TextEncoder().encode(text).byteLength,
      uri: skillUri,
    });
    const catalog = resultOf(await parsed(await legacy(5, "skills/list", {})));
    const skills = at(catalog, "skills");
    if (!(Array.isArray(skills) && isJsonObject(skills[0]))) {
      throw new Error("skills/list had no skill");
    }
    expect(await manifestOf(skills[0], text)).toMatchObject({
      digest: await digestOf(text),
      size: new TextEncoder().encode(text).byteLength,
      uri: skillUri,
    });
    expect(at(catalog, "nextCursor")).toBeUndefined();
    expect(at(catalog, "resultType")).toBeUndefined();
    expect(at(got, "ttlMs")).toBeUndefined();
    expect(at(got, "cacheScope")).toBeUndefined();
  });

  test("a 2026 client discovers the skills extension", async () => {
    const discovered = resultOf(
      await parsed(await modern(1, "server/discover", {}))
    );
    expect(at(discovered, "capabilities")).toEqual({
      extensions: { "io.modelcontextprotocol/skills": {} },
      resources: { listChanged: false },
      tools: { listChanged: false },
    });
    expect(at(discovered, "instructions")).toBe(serverInstructions);
    const listed = resultOf(await parsed(await modern(2, "skills/list", {})));
    expect(at(listed, "resultType")).toBe("complete");
    expect(at(listed, "ttlMs")).toBe(300_000);
    expect(at(listed, "cacheScope")).toBe("public");
    const read = resultOf(
      await parsed(await modern(3, "resources/read", { uri: skillUri }))
    );
    expect(textOf(read)).toBe(skillMarkdown());
    expect(at(read, "resultType")).toBe("complete");
    expect(at(read, "ttlMs")).toBe(300_000);
    expect(at(read, "cacheScope")).toBe("public");
    const resources = resultOf(
      await parsed(await modern(4, "resources/list", {}))
    );
    expect(at(resources, "ttlMs")).toBe(300_000);
    expect(at(resources, "cacheScope")).toBe("public");
  });

  test("an unknown skill uri is invalid params", async () => {
    const missing = await parsed(
      await legacy(6, "skills/get", { uri: "skill://missing/SKILL.md" })
    );
    expect(codeOf(missing)).toBe(-32_602);
    expect(messageOf(missing)).toBe("Unknown skill");
    expect(codeOf(await parsed(await legacy(7, "skills/get", {})))).toBe(
      -32_602
    );
    expect(codeOf(await parsed(await legacy(10, "skills/get", "nope")))).toBe(
      -32_600
    );
    expect(codeOf(await parsed(await legacy(11, "skills/get", [])))).toBe(
      -32_600
    );
    expect(
      codeOf(
        await parsed(
          await legacy(8, "resources/directory/read", {
            uri: "skill://agent-rooms",
          })
        )
      )
    ).toBe(-32_601);
    expect(
      codeOf(
        await parsed(
          await legacy(9, "resources/read", { uri: "skill://missing/SKILL.md" })
        )
      )
    ).toBe(-32_602);
  });
});
