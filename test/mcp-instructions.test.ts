import { describe, expect, test } from "bun:test";
import { Context, Effect, Schema } from "effect";
import type { Json } from "effect/Schema";
import { Chat } from "../src/app/chat.ts";
import { Actor } from "../src/domain/actor.ts";
import { AgentId } from "../src/domain/ids.ts";
import { IdentityView } from "../src/domain/message.ts";
import { agentInstructions } from "../src/mcp/guide.ts";
import { serveMcp } from "../src/mcp/handler.ts";
import { protocolVersionMetaKey } from "../src/mcp/protocol.ts";

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
