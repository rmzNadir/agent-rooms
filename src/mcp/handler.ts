import {
  createMcpHandler,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  fromJsonSchema,
  McpServer,
  type JsonSchemaType,
  type jsonSchemaValidator,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server"
import { Context, Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { Chat, type ChatError } from "../app/chat.ts"
import type { Actor } from "../domain/actor.ts"
import { InvalidArgument, publicErrorBody } from "../domain/errors.ts"
import { AgentId, internalRequestId, makeRequestId, RoomId, type RequestId } from "../domain/ids.ts"
import { agentInstructions } from "./guide.ts"
import { supportedProtocolVersions, unsupportedProtocolVersionBody, versionRejection } from "./protocol.ts"

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

const streamAccept = "application/json, text/event-stream"

const effectValidatesArguments = {
  getValidator: () => (input: unknown) => ({ valid: true, data: input, errorMessage: undefined }),
} as jsonSchemaValidator

const readCapped = async (
  request: { readonly headers: { get(name: string): string | null }; readonly body: ReadableStream<Uint8Array> | null },
  max: number,
): Promise<string | undefined> => {
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > max) return undefined
  const body = request.body
  if (body === null) return ""
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

const singleSseData = (body: string): string | undefined => {
  const data = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line.length > 0)
  const payload = data[0]
  if (data.length !== 1 || payload === undefined) return undefined
  try {
    JSON.parse(payload)
  } catch {
    return undefined
  }
  return payload
}

const jsonResponse = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "application/json" } })

const serverFor = (actor: Actor, services: Context.Context<Chat>) => {
  const server = new McpServer(
    { name: "agent-rooms", version: "0.1.0" },
    {
      instructions: agentInstructions,
      capabilities: { tools: { listChanged: false } },
      supportedProtocolVersions: [...supportedProtocolVersions],
    },
  )
  for (const tool of tools) {
    const inputSchema = fromJsonSchema(tool.inputSchema as JsonSchemaType, effectValidatesArguments)
    server.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON>(
      tool.name,
      { description: tool.description, inputSchema },
      async (args) => {
        const raw = args !== null && typeof args === "object" ? args : {}
        const body = await yieldTool(services, actor, tool.name, raw)
        return {
          content: body.content.map((block) => ({ type: block.type, text: block.text })),
          isError: body.isError,
        }
      },
    )
  }
  return server
}

const yieldTool = (services: Context.Context<Chat>, actor: Actor, name: string, raw: unknown) =>
  Effect.runPromiseWith(services)(
    Effect.gen(function* () {
      const requestId = yield* Effect.catchTag(makeRequestId(), "SchemaError", () => Effect.succeed(internalRequestId))
      return yield* Effect.catchTag(callTool(actor, name, raw, requestId), "InvalidArgument", toolErr)
    }),
  )

export const serveMcp = async (web: Request, actor: Actor, services: Context.Context<Chat>): Promise<Response> => {
  const accept = web.headers.get("accept") ?? ""
  const wantsStream = accept.includes("text/event-stream")
  const headers = new Headers(web.headers)
  if (!wantsStream) headers.set("accept", streamAccept)
  const forwarded = new Request(web, { headers })
  const bodyText = await readCapped(forwarded.clone(), DEFAULT_MAX_REQUEST_BODY_SIZE)
  const rejection =
    bodyText === undefined ? undefined : versionRejection(bodyText, forwarded.headers.get("mcp-protocol-version"))
  if (rejection !== undefined) return jsonResponse(JSON.stringify(unsupportedProtocolVersionBody(rejection)), 400)
  const handler = createMcpHandler(() => serverFor(actor, services), { legacy: "stateless" })
  const response = await handler.fetch(forwarded, {
    authInfo: { token: "bearer", clientId: actor.agentId, scopes: [], extra: { agentId: actor.agentId } },
  })
  if (wantsStream || !response.headers.get("content-type")?.includes("text/event-stream")) return response
  const text = await response.text()
  const payload = singleSseData(text)
  if (payload === undefined) return new Response(text, { status: response.status, headers: response.headers })
  return jsonResponse(payload, response.status)
}

export const handleMcp = (actor: Actor) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const services = yield* Effect.context<Chat>()
    const source = request.source
    if (!(source instanceof Request)) return yield* Effect.die("The worker request has no web Request.")
    const response = yield* Effect.promise(() => serveMcp(source, actor, services))
    const bytes = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))
    return HttpServerResponse.uint8Array(bytes, {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
    })
  })
