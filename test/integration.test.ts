import { createServer, type Server } from "node:http"
import { mkdtempSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { createLane, handleWake, markDelivered, resumeUnfinished, writePendingFile } from "../listeners/common.mjs"
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
    const listed = yield* post(
      `${url}/mcp`,
      { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "list_rooms", arguments: {} } },
      agent.token,
    )
    if (!listed.text.includes(roomId)) return yield* Effect.die(listed.text)

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
    const unread = yield* post(
      `${url}/mcp`,
      { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "get_unread", arguments: { room: roomId } } },
      agent.token,
    )
    if (!/lastReadSeq\\":[1-9]/.test(unread.text)) return yield* Effect.die(unread.text)

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

    const joined = yield* post(
      `${url}/mcp`,
      { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "join", arguments: { room: roomId } } },
      sam.token,
    )
    if (joined.status !== 200 || joined.text.includes("\"isError\":true")) return yield* Effect.die(joined.text)
    const wsUrl = `${url.replace(/^http/, "ws")}/api/rooms/${roomId}/ws`
    let finishClose: (code: number) => void = () => undefined
    let failClose: (error: Error) => void = () => undefined
    const closed = new Promise<number>((resolve, reject) => {
      finishClose = resolve
      failClose = reject
    })
    const socket = yield* Effect.promise(
      () =>
        new Promise<WebSocket>((resolve, reject) => {
          const pending = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${agent.token}` } })
          const openTimer = setTimeout(() => reject(new Error("socket did not open")), 5_000)
          const closeTimer = setTimeout(() => failClose(new Error("socket stayed open after leave")), 5_000)
          pending.onclose = (event) => {
            clearTimeout(closeTimer)
            finishClose(event.code)
          }
          pending.onopen = () => {
            clearTimeout(openTimer)
            resolve(pending)
          }
          pending.onerror = () => {
            clearTimeout(openTimer)
            clearTimeout(closeTimer)
            reject(new Error("socket failed to open"))
          }
        }),
    )
    const left = yield* post(
      `${url}/mcp`,
      { jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "leave", arguments: { room: roomId } } },
      agent.token,
    )
    if (left.text.includes("\"isError\":true")) return yield* Effect.die(left.text)
    const closeCode = yield* Effect.promise(() => closed)
    void socket
    if (closeCode !== 1000) return yield* Effect.die(`socket closed with ${closeCode}`)
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

test(
  "a delivered wake carries the unseen seq range and the next wake starts after it",
  Effect.gen(function* () {
    const compiled = yield* ready
    const url = compiled.url
    if (url === undefined) return yield* Effect.die("The local worker did not publish a url.")
    const wakes: Array<Record<string, unknown>> = []
    const server: Server = yield* Effect.promise(
      () =>
        new Promise<Server>((resolve) => {
          const receiver = createServer((request, response) => {
            const chunks: Buffer[] = []
            request.on("data", (chunk: Buffer) => chunks.push(chunk))
            request.on("end", () => {
              wakes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
              response.writeHead(200, { "content-type": "application/json" })
              response.end("{\"ok\":true}")
            })
          })
          receiver.listen(0, "127.0.0.1", () => resolve(receiver))
        }),
    )
    const address = server.address()
    if (address === null || typeof address === "string") return yield* Effect.die("The webhook receiver did not bind.")
    const port = (address as AddressInfo).port
    const admin = process.env.AGENT_ROOMS_ADMIN_TOKEN ?? ""
    const created = yield* post(
      `${url}/admin/agents`,
      { displayName: `hook${suffix}`, kind: "agent", webhookUrl: `http://127.0.0.1:${port}/wake` },
      admin,
    )
    if (created.status !== 200) return yield* Effect.die(created.text)
    const hook = yield* Schema.decodeEffect(Schema.fromJsonString(Created))(created.text)
    const posterCreated = yield* post(
      `${url}/admin/agents`,
      { displayName: `page${suffix}`, kind: "agent", webhookUrl: null },
      admin,
    )
    if (posterCreated.status !== 200) return yield* Effect.die(posterCreated.text)
    const poster = yield* Schema.decodeEffect(Schema.fromJsonString(Created))(posterCreated.text)
    const room = yield* post(
      `${url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_room",
          arguments: { name: `wake-${suffix}`, topic: "delivery", members: [hook.agent.agentId] },
        },
      },
      poster.token,
    )
    if (room.status !== 200) return yield* Effect.die(room.text)
    const roomId = /room_[0-9a-f]{24}/.exec(room.text)?.[0]
    if (roomId === undefined) return yield* Effect.die(room.text)
    const say = (id: number, body: string) =>
      post(
        `${url}/mcp`,
        {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "post_message",
            arguments: { room: roomId, body, mentions: [hook.agent.displayName] },
          },
        },
        poster.token,
      )
    const firstPost = yield* say(2, `one @${hook.agent.displayName}`)
    if (firstPost.text.includes("\"isError\":true")) return yield* Effect.die(firstPost.text)
    const waitFor = (count: number) =>
      Effect.gen(function* () {
        const deadline = Date.now() + 20_000
        while (wakes.length < count && Date.now() < deadline) yield* Effect.sleep("200 millis")
        if (wakes.length < count) return yield* Effect.die(`expected ${count} wakes, saw ${JSON.stringify(wakes)}`)
      })
    yield* waitFor(1)
    const first = wakes[0]
    if (first === undefined) return yield* Effect.die("missing first wake")
    if (first.fromSeq !== 0 || first.sinceCursor !== first.fromSeq) return yield* Effect.die(JSON.stringify(first))
    if (typeof first.toSeq !== "number" || first.toSeq < 1) return yield* Effect.die(JSON.stringify(first))
    if (typeof first.deliveryId !== "string" || !first.deliveryId.startsWith("dlv_")) {
      return yield* Effect.die(JSON.stringify(first))
    }
    const secondPost = yield* say(3, `two @${hook.agent.displayName}`)
    if (secondPost.text.includes("\"isError\":true")) return yield* Effect.die(secondPost.text)
    yield* waitFor(2)
    const second = wakes[1]
    if (second === undefined || second.fromSeq !== first.toSeq) return yield* Effect.die(JSON.stringify(wakes))
    server.close()
  }),
)

test(
  "a failed harness posts @human and a restarted listener marks the saved range read",
  Effect.gen(function* () {
    const compiled = yield* ready
    const url = compiled.url
    if (url === undefined) return yield* Effect.die("The local worker did not publish a url.")
    const mcpUrl = `${url}/mcp`
    const pending = mkdtempSync(path.join(tmpdir(), "agent-rooms-live-pending-"))
    const starts: number[] = []
    const marks: number[] = []
    let secret = ""
    let token = ""
    let failServer: Server | undefined
    let resumeServer: Server | undefined
    const stop = () => {
      failServer?.close()
      resumeServer?.close()
    }
    const die = (message: string) => {
      stop()
      return Effect.die(message)
    }
    const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)
    failServer = yield* Effect.promise(
      () =>
        new Promise<Server>((resolve) => {
          const receiver = createServer(async (request, response) => {
            const chunks: Buffer[] = []
            for await (const chunk of request) chunks.push(chunk)
            const body = Buffer.concat(chunks).toString("utf8")
            const result = await handleWake(
              {
                method: request.method,
                body,
                timestamp: header(request.headers["x-agent-rooms-timestamp"]),
                signature: header(request.headers["x-agent-rooms-signature"]),
              },
              {
                config: { webhookSecret: secret, agentName: "ada", mcpUrl, bearerToken: token },
                seenSignatures: new Map(),
                seenDeliveries: new Map(),
                lane: createLane(),
                pendingDir: pending,
                sleep: async () => undefined,
                start: async () => {
                  starts.push(1)
                  return { status: 500, body: { ok: false } }
                },
                markRead: async (_config, wake: { toSeq: number }) => {
                  marks.push(wake.toSeq)
                },
              },
            )
            response.writeHead(result.status, { "content-type": "application/json" })
            response.end(JSON.stringify(result.body))
            void result.done
          })
          receiver.listen(0, "127.0.0.1", () => resolve(receiver))
        }),
    )
    const failAddress = failServer.address()
    if (failAddress === null || typeof failAddress === "string") return yield* die("The failing listener did not bind.")
    const admin = process.env.AGENT_ROOMS_ADMIN_TOKEN ?? ""
    const CreatedSecret = Schema.Struct({
      token: Schema.String,
      webhookSecret: Schema.String,
      agent: Schema.Struct({ agentId: Schema.String, displayName: Schema.String }),
    })
    const failed = yield* post(
      `${url}/admin/agents`,
      {
        displayName: `fail${suffix}`,
        kind: "agent",
        webhookUrl: `http://127.0.0.1:${(failAddress as AddressInfo).port}/wake`,
      },
      admin,
    )
    if (failed.status !== 200) return yield* die(failed.text)
    const hook = yield* Schema.decodeEffect(Schema.fromJsonString(CreatedSecret))(failed.text)
    secret = hook.webhookSecret
    token = hook.token
    const posterCreated = yield* post(
      `${url}/admin/agents`,
      { displayName: `tell${suffix}`, kind: "agent", webhookUrl: null },
      admin,
    )
    if (posterCreated.status !== 200) return yield* die(posterCreated.text)
    const poster = yield* Schema.decodeEffect(Schema.fromJsonString(Created))(posterCreated.text)
    const room = yield* post(
      `${url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_room",
          arguments: { name: `retry-${suffix}`, topic: "retry", members: [hook.agent.agentId] },
        },
      },
      poster.token,
    )
    if (room.status !== 200) return yield* die(room.text)
    const roomId = /room_[0-9a-f]{24}/.exec(room.text)?.[0]
    if (roomId === undefined) return yield* die(room.text)
    const said = yield* post(
      `${url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "post_message",
          arguments: {
            room: roomId,
            body: `wake the failing agent @${hook.agent.displayName}`,
            mentions: [hook.agent.displayName],
          },
        },
      },
      poster.token,
    )
    if (said.text.includes("\"isError\":true")) return yield* die(said.text)
    const deadline = Date.now() + 20_000
    let transcript = ""
    while (Date.now() < deadline) {
      const read = yield* post(
        `${url}/mcp`,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "read_messages", arguments: { room: roomId, since: 0, limit: 20 } },
        },
        poster.token,
      )
      transcript = read.text
      if (transcript.includes("I failed to process messages") && transcript.includes("@human")) break
      yield* Effect.sleep("200 millis")
    }
    if (!transcript.includes("@human") || !transcript.includes("I failed to process messages")) {
      return yield* die(`${transcript}\nstarts=${starts.length}`)
    }
    if (starts.length !== 3 || marks.length !== 0) return yield* die(`starts=${starts.length} marks=${marks.join(",")}`)
    const unread = yield* post(
      `${url}/mcp`,
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_unread", arguments: { room: roomId } } },
      hook.token,
    )
    if (!/lastReadSeq\\":0/.test(unread.text)) return yield* die(unread.text)

    const savedWakes: Array<Record<string, unknown>> = []
    resumeServer = yield* Effect.promise(
      () =>
        new Promise<Server>((resolve) => {
          const receiver = createServer((request, response) => {
            const chunks: Buffer[] = []
            request.on("data", (chunk: Buffer) => chunks.push(chunk))
            request.on("end", () => {
              savedWakes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
              response.writeHead(200, { "content-type": "application/json" })
              response.end("{\"ok\":true}")
            })
          })
          receiver.listen(0, "127.0.0.1", () => resolve(receiver))
        }),
    )
    const resumeAddress = resumeServer.address()
    if (resumeAddress === null || typeof resumeAddress === "string") return yield* die("The resume listener did not bind.")
    const resumed = yield* post(
      `${url}/admin/agents`,
      {
        displayName: `redo${suffix}`,
        kind: "agent",
        webhookUrl: `http://127.0.0.1:${(resumeAddress as AddressInfo).port}/wake`,
      },
      admin,
    )
    if (resumed.status !== 200) return yield* die(resumed.text)
    const redo = yield* Schema.decodeEffect(Schema.fromJsonString(CreatedSecret))(resumed.text)
    const invited = yield* post(
      `${url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "invite", arguments: { room: roomId, agent_id: redo.agent.agentId } },
      },
      poster.token,
    )
    if (invited.status !== 200) return yield* die(invited.text)
    const joined = yield* post(
      `${url}/mcp`,
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "join", arguments: { room: roomId } } },
      redo.token,
    )
    if (joined.text.includes("\"isError\":true")) return yield* die(joined.text)
    const again = yield* post(
      `${url}/mcp`,
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "post_message",
          arguments: {
            room: roomId,
            body: `wake the restarted agent @${redo.agent.displayName}`,
            mentions: [redo.agent.displayName],
          },
        },
      },
      poster.token,
    )
    if (again.text.includes("\"isError\":true")) return yield* die(again.text)
    const wakeDeadline = Date.now() + 20_000
    while (savedWakes.length < 1 && Date.now() < wakeDeadline) yield* Effect.sleep("200 millis")
    const wake = savedWakes[0]
    if (wake === undefined || typeof wake.toSeq !== "number" || typeof wake.roomId !== "string" || typeof wake.agentId !== "string") {
      return yield* die(JSON.stringify(savedWakes))
    }
    const resumeDir = mkdtempSync(path.join(tmpdir(), "agent-rooms-resume-"))
    writePendingFile(resumeDir, wake.roomId, wake.agentId, {
      wake,
      attempts: 1,
      phase: "running",
      followUp: null,
    })
    const resumeMarks: number[] = []
    yield* Effect.promise(() =>
      resumeUnfinished(resumeDir, {
        config: { agentName: redo.agent.displayName, mcpUrl, bearerToken: redo.token },
        lane: createLane(),
        pendingDir: resumeDir,
        sleep: async () => undefined,
        start: async () => ({ status: 200, body: { ok: true } }),
        markRead: async (config, payload) => {
          const wake = payload as { roomId: string; toSeq: number }
          resumeMarks.push(wake.toSeq)
          await markDelivered(config as { mcpUrl?: string; bearerToken?: string }, wake)
        },
      }),
    )
    if (resumeMarks.length !== 1 || resumeMarks[0] !== wake.toSeq) return yield* die(JSON.stringify(resumeMarks))
    const after = yield* post(
      `${url}/mcp`,
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "get_unread", arguments: { room: roomId } } },
      redo.token,
    )
    if (!new RegExp(`lastReadSeq\\\\":${wake.toSeq}(?!\\d)`).test(after.text)) return yield* die(after.text)
    stop()
  }),
)
