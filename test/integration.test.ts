import { localState } from "alchemy"
import { HOP_LIMIT } from "../src/domain/wake-policy.ts"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Test from "alchemy/Test/Bun"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

process.env.AGENT_ROOMS_LOCAL_STATE = "1"
process.env.AGENT_ROOMS_ADMIN_TOKEN ??= "integration-admin-token"
process.env.AGENT_ROOMS_ADMIN_NAME ??= "human"

const { default: Stack } = await import("../alchemy.run.ts")

const { test, beforeAll, deploy } = Test.make({
  providers: Cloudflare.providers(),
  state: localState(),
  dev: true,
  sidecar: false,
  stage: "dev-agent-rooms",
})

const ready = beforeAll(deploy(Stack))
const suffix = Math.random().toString(16).slice(2, 8)

const Health = Schema.Struct({ ok: Schema.Literal(true) })
const Created = Schema.Struct({
  token: Schema.String,
  agent: Schema.Struct({ agentId: Schema.String, displayName: Schema.String }),
})
const Rpc = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
})

const post = (url: string, body: unknown, token?: string) =>
  Effect.gen(function* () {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (token !== undefined) headers.authorization = `Bearer ${token}`
    const request = HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url, { headers }), body)
    const response = yield* HttpClient.execute(request)
    const text = yield* response.text
    return { status: response.status, text }
  })

test(
  "health, viewer, and an agent conversation",
  Effect.gen(function* () {
    const compiled = yield* ready
    const url = compiled.url
    if (url === undefined) return yield* Effect.die("The local worker did not publish a url.")
    const health = yield* HttpClient.get(`${url}/health`)
    const healthText = yield* health.text
    yield* Schema.decodeEffect(Schema.fromJsonString(Health))(healthText)

    const home = yield* HttpClient.get(`${url}/`)
    const html = yield* home.text
    if (!html.includes("agent-rooms") || !html.includes("Bearer token")) {
      return yield* Effect.die("The viewer did not render the sign-in form.")
    }

    const admin = process.env.AGENT_ROOMS_ADMIN_TOKEN ?? ""
    const created = yield* post(
      `${url}/admin/agents`,
      { displayName: `ada${suffix}`, kind: "agent", webhookUrl: null },
      admin,
    )
    if (created.status !== 200) return yield* Effect.die(created.text)
    const agent = yield* Schema.decodeEffect(Schema.fromJsonString(Created))(created.text)

    const init = yield* post(`${url}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    }, agent.token)
    if (init.status !== 200) return yield* Effect.die(init.text)
    yield* Schema.decodeEffect(Schema.fromJsonString(Rpc))(init.text)

    const room = yield* post(
      `${url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "create_room", arguments: { name: `launch-${suffix}`, topic: "ship v1", members: [] } },
      },
      agent.token,
    )
    if (room.status !== 200 || !room.text.includes("room_")) return yield* Effect.die(room.text)
    const roomIdMatch = /room_[0-9a-f]{24}/.exec(room.text)
    const roomId = roomIdMatch?.[0]
    if (roomId === undefined) return yield* Effect.die(room.text)

    const untagged = yield* post(
      `${url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "post_message", arguments: { room: roomId, body: "hello", mentions: [] } },
      },
      agent.token,
    )
    if (!untagged.text.includes("MentionRequired")) return yield* Effect.die(untagged.text)

    const human = yield* post(
      `${url}/admin/agents`,
      { displayName: `sam${suffix}`, kind: "human", webhookUrl: null },
      admin,
    )
    if (human.status !== 200) return yield* Effect.die(human.text)
    const sam = yield* Schema.decodeEffect(Schema.fromJsonString(Created))(human.text)
    const invited = yield* post(
      `${url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "invite", arguments: { room: roomId, agent_id: sam.agent.agentId } },
      },
      agent.token,
    )
    if (invited.status !== 200) return yield* Effect.die(invited.text)

    const posted = yield* post(
      `${url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "post_message",
          arguments: { room: roomId, body: "status @human", mentions: ["human"] },
        },
      },
      agent.token,
    )
    if (!posted.text.includes("status @human") || posted.text.includes("\"isError\":true")) {
      return yield* Effect.die(posted.text)
    }

    const read = yield* post(
      `${url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "read_messages", arguments: { room: roomId, since: 0, limit: 20 } },
      },
      agent.token,
    )
    if (!read.text.includes("status @human")) return yield* Effect.die(read.text)

    const quiet = yield* post(
      `${url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "wait_for_messages",
          arguments: { room: roomId, since: 999, limit: 10, timeout_ms: 400 },
        },
      },
      agent.token,
    )
    if (quiet.status !== 200 || quiet.text.includes("\"isError\":true")) return yield* Effect.die(quiet.text)
  }),
)

test(
  "the hop limit pauses the next agent post, including two posts at once",
  Effect.gen(function* () {
    const compiled = yield* ready
    const url = compiled.url
    if (url === undefined) return yield* Effect.die("The local worker did not publish a url.")
    const admin = process.env.AGENT_ROOMS_ADMIN_TOKEN ?? ""
    const makeAgent = (name: string) =>
      Effect.gen(function* () {
        const created = yield* post(
          `${url}/admin/agents`,
          { displayName: `${name}${suffix}`, kind: "agent", webhookUrl: null },
          admin,
        )
        if (created.status !== 200) return yield* Effect.die(created.text)
        return yield* Schema.decodeEffect(Schema.fromJsonString(Created))(created.text)
      })
    const bob = yield* makeAgent("bob")
    const cara = yield* makeAgent("cara")
    const room = yield* post(
      `${url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_room",
          arguments: { name: `relay-${suffix}`, topic: "hops", members: [cara.agent.agentId] },
        },
      },
      bob.token,
    )
    if (room.status !== 200) return yield* Effect.die(room.text)
    const roomId = /room_[0-9a-f]{24}/.exec(room.text)?.[0]
    if (roomId === undefined) return yield* Effect.die(room.text)
    const say = (id: number, token: string) =>
      post(
        `${url}/mcp`,
        {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "post_message",
            arguments: {
              room: roomId,
              body: `ping ${id} @${cara.agent.displayName}`,
              mentions: [cara.agent.displayName],
            },
          },
        },
        token,
      )
    for (let n = 0; n < HOP_LIMIT - 1; n++) {
      const posted = yield* say(n + 2, bob.token)
      if (posted.text.includes("paused after 20") || posted.text.includes("\"isError\":true")) {
        return yield* Effect.die(posted.text)
      }
    }
    const pair = yield* Effect.all([say(100, bob.token), say(101, bob.token)], { concurrency: 2 })
    const pauses = pair.filter((posted) => posted.text.includes("paused after 20")).length
    if (pauses !== 1) return yield* Effect.die(pair.map((posted) => posted.text).join("\n"))
  }),
)
