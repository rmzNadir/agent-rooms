import { describe, expect, test } from "bun:test"
import { Context, Schema } from "effect"
import { Chat } from "../src/app/chat.ts"
import { Actor } from "../src/domain/actor.ts"
import { AgentId } from "../src/domain/ids.ts"
import { IdentityView } from "../src/domain/message.ts"
import { agentInstructions } from "../src/mcp/guide.ts"
import { serveMcp } from "../src/mcp/handler.ts"
import { protocolVersionMetaKey } from "../src/mcp/protocol.ts"

const agentId = Schema.decodeUnknownSync(AgentId)("agent_aaaaaaaaaaaaaaaaaaaaaaaa")
const actor = new Actor({ agentId, displayName: "ada", kind: "agent", admin: false })
const services = Context.make(Chat, {
  whoami: () => new IdentityView({ agentId, displayName: "ada", kind: "agent", admin: false }),
} as unknown as Chat["Service"])

const post = (body: unknown, headers: Record<string, string>) =>
  serveMcp(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    actor,
    services,
  )

describe("mcp instructions", () => {
  test("initialize returns the guide", async () => {
    const response = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      },
      { "mcp-protocol-version": "2025-06-18" },
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain(agentInstructions)
  })

  test("a bad room id is the public error envelope", async () => {
    const response = await post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "post_message", arguments: { room: "nope", body: "hi", mentions: ["ada"] } },
      },
      { "mcp-protocol-version": "2025-06-18" },
    )
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(text).toContain("InvalidArgument")
    expect(text).toContain("requestId")
  })

  test("a dropped protocol version in a batch is rejected", async () => {
    const response = await post(
      [
        {
          jsonrpc: "2.0",
          id: 4,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
        },
      ],
      { "mcp-protocol-version": "2025-03-26" },
    )
    const text = await response.text()
    expect(response.status).toBe(400)
    expect(text).toContain("-32022")
    expect(text).toContain("2026-07-28")
  })

  test("server/discover returns the guide", async () => {
    const response = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {
          _meta: {
            [protocolVersionMetaKey]: "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain(agentInstructions)
  })
})
