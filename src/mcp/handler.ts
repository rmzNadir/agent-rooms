import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { json } from "../api/respond.ts"
import { Chat, type ChatError } from "../app/chat.ts"
import type { Actor } from "../domain/actor.ts"
import { InvalidArgument, publicErrorBody } from "../domain/errors.ts"
import { AgentId, internalRequestId, makeRequestId, RoomId, type RequestId } from "../domain/ids.ts"

const protocolVersions = ["2025-06-18", "2025-03-26", "2024-11-05"] as const

const RpcMessage = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.String,
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  params: Schema.optional(Schema.Unknown),
})

const Args = Schema.Record(Schema.String, Schema.Unknown)
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const toJson = (value: unknown) =>
  Effect.catchTag(encodeJson(value), "SchemaError", () =>
    Effect.succeed(
      '{"code":"Unavailable","message":"The response could not be encoded. Retry the same request.","details":{},"requestId":"req_000000000000000000000001","retryable":true}',
    ),
  )

type ToolBody = {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
  readonly isError: boolean
}

const toolOk = (value: unknown) =>
  Effect.map(toJson(value), (text): ToolBody => ({ content: [{ type: "text", text }], isError: false }))

const toolErr = (error: {
  readonly code: string
  readonly message: string
  readonly details: object
  readonly requestId: RequestId
  readonly retryable: boolean
}) =>
  Effect.map(
    toJson(publicErrorBody(error)),
    (text): ToolBody => ({ content: [{ type: "text", text }], isError: true }),
  )

const asTool = <A>(effect: Effect.Effect<A, ChatError>) =>
  Effect.catchTags(Effect.flatMap(effect, toolOk), {
    MentionRequired: toolErr,
    UnknownMention: toolErr,
    SelfMentionOnly: toolErr,
    NotMember: toolErr,
    NotInvited: toolErr,
    NotAuthor: toolErr,
    Forbidden: toolErr,
    Unauthorized: toolErr,
    RoomNotFound: toolErr,
    MessageNotFound: toolErr,
    AgentNotFound: toolErr,
    RoomNameTaken: toolErr,
    LeadRequired: toolErr,
    InvalidArgument: toolErr,
    PersistenceFailed: toolErr,
    Unavailable: toolErr,
  })

const invalid = (requestId: RequestId, field: string, constraint: string) =>
  new InvalidArgument({
    code: "InvalidArgument",
    operation: "tools/call",
    message: `${field} ${constraint}. Correct it and retry.`,
    requestId,
    details: { field, constraint },
    retryable: false,
  })

const decode = <A>(schema: Schema.Decoder<A>, value: unknown, requestId: RequestId, field: string) =>
  Effect.catchTag(Schema.decodeUnknownEffect(schema)(value), "SchemaError", () =>
    Effect.fail(invalid(requestId, field, "does not match the tool schema")),
  )

const rpcResult = (id: string | number | null, result: unknown) => json(200, { jsonrpc: "2.0", id, result })

const rpcError = (id: string | number | null, code: number, message: string) =>
  json(200, { jsonrpc: "2.0", id, error: { code, message } })

const objectSchema = (properties: Record<string, unknown>, required: ReadonlyArray<string>) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

const stringProp = { type: "string" }
const numberProp = { type: "number" }
const nullableNumber = { type: ["number", "null"] }
const stringArray = { type: "array", items: { type: "string" } }

const noMentions: ReadonlyArray<string> = []
const noMembers: ReadonlyArray<AgentId> = []

const tools = [
  { name: "list_rooms", description: "Rooms visible to the caller.", inputSchema: objectSchema({}, []) },
  {
    name: "create_room",
    description: "Create a room for one project. The first agent member becomes the lead coordinator.",
    inputSchema: objectSchema(
      { name: stringProp, topic: stringProp, members: stringArray },
      ["name"],
    ),
  },
  {
    name: "invite",
    description: "Invite an agent. They are not a member until they call join.",
    inputSchema: objectSchema({ room: stringProp, agent_id: stringProp }, ["room", "agent_id"]),
  },
  { name: "join", description: "Join a room you were invited to.", inputSchema: objectSchema({ room: stringProp }, ["room"]) },
  {
    name: "leave",
    description: "Leave a room. The lead role moves to another member when one remains.",
    inputSchema: objectSchema({ room: stringProp }, ["room"]),
  },
  { name: "members", description: "List members of a room.", inputSchema: objectSchema({ room: stringProp }, ["room"]) },
  {
    name: "post_message",
    description: "Post a message. Agents must @mention a target. An untagged human post wakes every agent member.",
    inputSchema: objectSchema(
      { room: stringProp, body: stringProp, mentions: stringArray, thread_root: nullableNumber, reply_to: nullableNumber },
      ["room", "body"],
    ),
  },
  {
    name: "read_messages",
    description: "Messages strictly after since. A wake payload's since cursor belongs here.",
    inputSchema: objectSchema(
      { room: stringProp, since: numberProp, limit: numberProp, thread: nullableNumber },
      ["room"],
    ),
  },
  {
    name: "read_transcript",
    description: "Paginated transcript as markdown or json.",
    inputSchema: objectSchema(
      { room: stringProp, since: numberProp, limit: numberProp, thread: nullableNumber, format: { type: "string", enum: ["markdown", "json"] } },
      ["room"],
    ),
  },
  {
    name: "list_threads",
    description: "Thread roots in a room.",
    inputSchema: objectSchema({ room: stringProp, limit: numberProp }, ["room"]),
  },
  {
    name: "search_messages",
    description: "Search message bodies in a room.",
    inputSchema: objectSchema({ room: stringProp, query: stringProp, limit: numberProp }, ["room", "query"]),
  },
  {
    name: "wait_for_messages",
    description: "Long-poll for messages after since. The server caps the wait at 25 seconds.",
    inputSchema: objectSchema(
      { room: stringProp, since: numberProp, limit: numberProp, timeout_ms: numberProp },
      ["room"],
    ),
  },
  { name: "get_unread", description: "Unread count since the caller's read cursor.", inputSchema: objectSchema({ room: stringProp }, ["room"]) },
  {
    name: "mark_read",
    description: "Advance the caller's read cursor to seq.",
    inputSchema: objectSchema({ room: stringProp, seq: numberProp }, ["room", "seq"]),
  },
  {
    name: "react",
    description: "Toggle a reaction. Reactions do not wake anyone.",
    inputSchema: objectSchema({ room: stringProp, seq: numberProp, emoji: stringProp }, ["room", "seq", "emoji"]),
  },
  {
    name: "edit_message",
    description: "Replace your own message body. Edits do not wake anyone.",
    inputSchema: objectSchema(
      { room: stringProp, seq: numberProp, body: stringProp, mentions: stringArray },
      ["room", "seq", "body"],
    ),
  },
  {
    name: "redact_message",
    description: "Redact your own message. An admin may redact any message.",
    inputSchema: objectSchema({ room: stringProp, seq: numberProp }, ["room", "seq"]),
  },
  { name: "whoami", description: "The authenticated identity.", inputSchema: objectSchema({}, []) },
  {
    name: "register_webhook",
    description: "Set the HTTPS URL that receives HMAC-signed wake payloads. Pass null to clear it.",
    inputSchema: objectSchema({ webhook_url: { type: ["string", "null"] } }, ["webhook_url"]),
  },
] as const

const callTool = (actor: Actor, name: string, rawArgs: unknown, requestId: RequestId) =>
  Effect.gen(function* () {
    const chat = yield* Chat
    const args = yield* decode(Args, rawArgs ?? {}, requestId, "arguments")
    const room = () => decode(RoomId, args.room, requestId, "room")
    const limit = (fallback: number) =>
      args.limit === undefined ? Effect.succeed(fallback) : decode(Schema.Number, args.limit, requestId, "limit")
    const since = () => (args.since === undefined ? Effect.succeed(0) : decode(Schema.Number, args.since, requestId, "since"))
    const thread = (key: "thread" | "thread_root" | "reply_to") =>
      args[key] === undefined ? Effect.succeed(null) : decode(Schema.NullOr(Schema.Number), args[key], requestId, key)
    const mentions = () =>
      args.mentions === undefined
        ? Effect.succeed(noMentions)
        : decode(Schema.Array(Schema.String), args.mentions, requestId, "mentions")

    switch (name) {
      case "whoami":
        return yield* toolOk(chat.whoami(actor))
      case "list_rooms":
        return yield* asTool(chat.listRooms(actor, requestId))
      case "create_room": {
        const roomName = yield* decode(Schema.String, args.name, requestId, "name")
        const topic = args.topic === undefined ? "" : yield* decode(Schema.String, args.topic, requestId, "topic")
        const members =
          args.members === undefined
            ? noMembers
            : yield* decode(Schema.Array(AgentId), args.members, requestId, "members")
        return yield* asTool(chat.createRoom({ actor, requestId, name: roomName, topic, memberIds: members }))
      }
      case "invite":
        return yield* asTool(chat.invite(actor, requestId, yield* room(), yield* decode(AgentId, args.agent_id, requestId, "agent_id")))
      case "join":
        return yield* asTool(chat.join(actor, requestId, yield* room()))
      case "leave":
        return yield* asTool(chat.leave(actor, requestId, yield* room()))
      case "members":
        return yield* asTool(chat.members(actor, requestId, yield* room()))
      case "post_message":
        return yield* asTool(
          chat.postMessage({
            actor,
            requestId,
            roomId: yield* room(),
            body: yield* decode(Schema.String, args.body, requestId, "body"),
            mentions: yield* mentions(),
            threadRoot: yield* thread("thread_root"),
            replyTo: yield* thread("reply_to"),
          }),
        )
      case "read_messages":
        return yield* asTool(
          chat.readMessages({
            actor,
            requestId,
            roomId: yield* room(),
            since: yield* since(),
            limit: yield* limit(50),
            thread: yield* thread("thread"),
          }),
        )
      case "read_transcript": {
        const format =
          args.format === undefined ? "markdown" : yield* decode(Schema.Literals(["markdown", "json"]), args.format, requestId, "format")
        return yield* asTool(
          chat.readTranscript({
            actor,
            requestId,
            roomId: yield* room(),
            since: yield* since(),
            limit: yield* limit(50),
            thread: yield* thread("thread"),
            format,
          }),
        )
      }
      case "list_threads":
        return yield* asTool(chat.listThreads(actor, requestId, yield* room(), yield* limit(50)))
      case "search_messages":
        return yield* asTool(
          chat.searchMessages(
            actor,
            requestId,
            yield* room(),
            yield* decode(Schema.String, args.query, requestId, "query"),
            yield* limit(50),
          ),
        )
      case "wait_for_messages": {
        const timeoutMs =
          args.timeout_ms === undefined ? 25_000 : yield* decode(Schema.Number, args.timeout_ms, requestId, "timeout_ms")
        return yield* asTool(
          chat.waitForMessages(actor, requestId, yield* room(), yield* since(), yield* limit(50), timeoutMs),
        )
      }
      case "get_unread":
        return yield* asTool(chat.getUnread(actor, requestId, yield* room()))
      case "mark_read":
        return yield* asTool(chat.markRead(actor, requestId, yield* room(), yield* decode(Schema.Number, args.seq, requestId, "seq")))
      case "react":
        return yield* asTool(
          chat.react(
            actor,
            requestId,
            yield* room(),
            yield* decode(Schema.Number, args.seq, requestId, "seq"),
            yield* decode(Schema.String, args.emoji, requestId, "emoji"),
          ),
        )
      case "edit_message":
        return yield* asTool(
          chat.editMessage(
            actor,
            requestId,
            yield* room(),
            yield* decode(Schema.Number, args.seq, requestId, "seq"),
            yield* decode(Schema.String, args.body, requestId, "body"),
            yield* mentions(),
          ),
        )
      case "redact_message":
        return yield* asTool(
          chat.redactMessage(actor, requestId, yield* room(), yield* decode(Schema.Number, args.seq, requestId, "seq")),
        )
      case "register_webhook":
        return yield* asTool(
          chat.registerWebhook(
            actor,
            requestId,
            yield* decode(Schema.NullOr(Schema.String), args.webhook_url, requestId, "webhook_url"),
          ),
        )
      default:
        return yield* asTool(Effect.fail(invalid(requestId, "name", "is not a tool this server provides")))
    }
  })

export const handleMcp = (actor: Actor) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.result(HttpServerRequest.schemaBodyJson(RpcMessage))
    if (parsed._tag === "Failure") {
      return yield* rpcError(null, -32700, "Request body must be a JSON-RPC 2.0 object.")
    }
    const message = parsed.success
    const id = message.id ?? null
    if (message.id === undefined || message.method.startsWith("notifications/")) {
      return HttpServerResponse.empty({ status: 202 })
    }
    if (message.method === "ping") return yield* rpcResult(id, {})
    if (message.method === "initialize") {
      const params = yield* Effect.result(Schema.decodeUnknownEffect(Args)(message.params ?? {}))
      const requested = params._tag === "Success" ? params.success.protocolVersion : undefined
      const protocolVersion = protocolVersions.find((version) => version === requested) ?? "2025-06-18"
      return yield* rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-rooms", version: "0.1.0" },
      })
    }
    if (message.method === "tools/list") {
      return yield* rpcResult(id, { tools })
    }
    if (message.method === "tools/call") {
      const params = yield* Effect.result(Schema.decodeUnknownEffect(Args)(message.params ?? {}))
      if (params._tag === "Failure") return yield* rpcError(id, -32602, "tools/call params must be an object.")
      const name = params.success.name
      if (typeof name !== "string") return yield* rpcError(id, -32602, "tools/call requires a string name.")
      const requestId = yield* Effect.catchTag(makeRequestId(), "SchemaError", () => Effect.succeed(internalRequestId))
      const result = yield* Effect.catchTag(
        callTool(actor, name, params.success.arguments ?? {}, requestId),
        "InvalidArgument",
        toolErr,
      )
      return yield* rpcResult(id, result)
    }
    return yield* rpcError(id, -32601, `Method ${message.method} is not implemented. Use initialize, tools/list, or tools/call.`)
  })
