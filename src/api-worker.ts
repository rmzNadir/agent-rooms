import * as Cloudflare from "alchemy/Cloudflare"
import { Config, Effect, Layer, Redacted, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { finish, finishResponse, json } from "./api/respond.ts"
import { Chat, chatLayer, type ChatError } from "./app/chat.ts"
import { Actor } from "./domain/actor.ts"
import { Forbidden, InvalidArgument, Unauthorized, Unavailable } from "./domain/errors.ts"
import { AgentId, internalRequestId, makeRequestId, RoomId, type RequestId } from "./domain/ids.ts"
import { hashToken } from "./domain/token.ts"
import DirectoryServer from "./directory/directory-server.ts"
import { handleMcp } from "./mcp/handler.ts"
import RoomServer from "./room/room-server.ts"
import { viewerHtml } from "./viewer/page.ts"

const SessionBody = Schema.Struct({ token: Schema.String })
const PostBody = Schema.Struct({
  body: Schema.String,
  mentions: Schema.optional(Schema.Array(Schema.String)),
})
const CreateAgentBody = Schema.Struct({
  displayName: Schema.String,
  kind: Schema.Literals(["agent", "human"]),
  webhookUrl: Schema.optional(Schema.NullOr(Schema.String)),
})
const WebhookBody = Schema.Struct({ webhookUrl: Schema.NullOr(Schema.String) })

const locate = (request: HttpServerRequest.HttpServerRequest) =>
  request.url.startsWith("http://") || request.url.startsWith("https://")
    ? new URL(request.url)
    : new URL(request.url, "http://localhost")

const tokenFrom = (request: HttpServerRequest.HttpServerRequest) => {
  const header = request.headers.authorization
  if (typeof header === "string") {
    const match = /^Bearer\s+(\S+)$/i.exec(header)
    const bearer = match?.[1]
    if (bearer !== undefined && bearer.length > 0) return bearer
  }
  const cookie = request.cookies.agent_rooms_token
  if (cookie !== undefined && cookie.length > 0) return cookie
  return undefined
}

const requestIdOf = Effect.catchTag(makeRequestId(), "SchemaError", () => Effect.succeed(internalRequestId))

const unauthorized = (requestId: RequestId) =>
  new Unauthorized({
    code: "Unauthorized",
    operation: "authenticate",
    message: "Send a bearer token for an agent, or the admin token.",
    requestId,
    details: {},
    retryable: false,
  })

const forbidden = (requestId: RequestId) =>
  new Forbidden({
    code: "Forbidden",
    operation: "admin",
    message: "That action needs the admin token. Retry with the admin bearer.",
    requestId,
    details: {},
    retryable: false,
  })

const configDown = new Unavailable({
  code: "Unavailable",
  operation: "authenticate",
  message: "The server could not read its admin token. Set AGENT_ROOMS_ADMIN_TOKEN and retry.",
  requestId: internalRequestId,
  details: {},
  retryable: true,
})

const loadActor = (token: string) =>
  Effect.gen(function* () {
    const chat = yield* Chat
    const adminToken = Redacted.value(
      yield* Effect.catchTag(Config.Redacted("AGENT_ROOMS_ADMIN_TOKEN"), "ConfigError", () => Effect.fail(configDown)),
    )
    const adminName = yield* Effect.catchTag(
      Config.String("AGENT_ROOMS_ADMIN_NAME").pipe(Config.withDefault("human")),
      "ConfigError",
      () => Effect.succeed("human"),
    )
    const tokenHash = yield* hashToken(token)
    const adminHash = yield* hashToken(adminToken)
    const identity = yield* chat.resolve(tokenHash, adminHash, adminName)
    return new Actor({
      agentId: identity.agentId,
      displayName: identity.displayName,
      kind: identity.kind,
      admin: identity.admin,
    })
  })

const authed = <R>(
  run: (actor: Actor, requestId: RequestId) => Effect.Effect<HttpServerResponse.HttpServerResponse, ChatError, R>,
) =>
  finishResponse(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const requestId = yield* requestIdOf
      const token = tokenFrom(request)
      if (token === undefined) return yield* unauthorized(requestId)
      const actor = yield* loadActor(token)
      return yield* run(actor, requestId)
    }),
  )

const adminOnly = <R>(
  run: (actor: Actor, requestId: RequestId) => Effect.Effect<HttpServerResponse.HttpServerResponse, ChatError, R>,
) =>
  authed((actor, requestId) => (actor.admin ? run(actor, requestId) : Effect.fail(forbidden(requestId))))

const badRoom = (requestId: RequestId) =>
  new InvalidArgument({
    code: "InvalidArgument",
    operation: "room.read",
    message: "room must be a room id. Check the path and retry.",
    requestId,
    details: { field: "room", constraint: "room_[24 hex]" },
    retryable: false,
  })

const badBody = (requestId: RequestId, field: string) =>
  new InvalidArgument({
    code: "InvalidArgument",
    operation: "http.body",
    message: `${field} could not be read. Send the JSON body described in the README and retry.`,
    requestId,
    details: { field, constraint: "json" },
    retryable: false,
  })

const decodeRoom = (value: string, requestId: RequestId) =>
  Effect.catchTag(Schema.decodeUnknownEffect(RoomId)(value), "SchemaError", () => Effect.fail(badRoom(requestId)))

const decodeAgent = (value: string, requestId: RequestId) =>
  Effect.catchTag(Schema.decodeUnknownEffect(AgentId)(value), "SchemaError", () =>
    Effect.fail(
      new InvalidArgument({
        code: "InvalidArgument",
        operation: "admin",
        message: "agent id must look like agent_ plus 24 hex characters. Check it and retry.",
        requestId,
        details: { field: "agentId", constraint: "agent_[24 hex]" },
        retryable: false,
      }),
    ),
  )

const readJson = <A>(schema: Schema.Decoder<A>, requestId: RequestId, field: string) =>
  Effect.catchTags(HttpServerRequest.schemaBodyJson(schema), {
    SchemaError: () => Effect.fail(badBody(requestId, field)),
    HttpServerError: () => Effect.fail(badBody(requestId, field)),
  })

const sinceParam = (url: URL) => {
  const raw = url.searchParams.get("since")
  return raw === null ? 0 : Number(raw)
}

const notFound = json(404, {
  code: "NotFound",
  message: "That path is not served. Use /mcp, /health, or the viewer.",
  details: {},
  requestId: internalRequestId,
  retryable: false,
})

const dispatch = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const url = locate(request)
  const path = url.pathname
  if (request.method === "GET" && path === "/health") return yield* json(200, { ok: true })
  if (request.method === "GET" && (path === "/" || path === "/rooms")) {
    return HttpServerResponse.text(viewerHtml(null), { contentType: "text/html; charset=utf-8" })
  }
  const viewerRoom = /^\/rooms\/(room_[0-9a-f]{24})$/.exec(path)
  if (request.method === "GET" && viewerRoom?.[1] !== undefined) {
    return HttpServerResponse.text(viewerHtml(viewerRoom[1]), { contentType: "text/html; charset=utf-8" })
  }
  if (request.method === "POST" && path === "/viewer/session") return yield* openSession
  if (request.method === "POST" && path === "/mcp") return yield* authed((actor) => handleMcp(actor))
  if (request.method === "GET" && path === "/api/whoami") {
    return yield* authed((actor) =>
      finish(
        Effect.gen(function* () {
          const chat = yield* Chat
          return chat.whoami(actor)
        }),
      ),
    )
  }
  if (request.method === "GET" && path === "/api/rooms") {
    return yield* authed((actor, requestId) =>
      finish(
        Effect.gen(function* () {
          const chat = yield* Chat
          return yield* chat.listRooms(actor, requestId)
        }),
      ),
    )
  }
  const roomApi = /^\/api\/rooms\/(room_[0-9a-f]{24})(?:\/(messages|threads|ws))?$/.exec(path)
  if (roomApi?.[1] !== undefined) {
    const rawRoom = roomApi[1]
    const leaf = roomApi[2]
    if (request.method === "GET" && leaf === "ws") {
      return yield* authed((actor, requestId) =>
        Effect.gen(function* () {
          const chat = yield* Chat
          const roomId = yield* decodeRoom(rawRoom, requestId)
          yield* chat.members(actor, requestId, roomId)
          return yield* chat.forward(roomId, request, requestId)
        }),
      )
    }
    if (request.method === "GET" && (leaf === undefined || leaf === "messages")) {
      return yield* authed((actor, requestId) =>
        finish(
          Effect.gen(function* () {
            const chat = yield* Chat
            return yield* chat.readMessages({
              actor,
              requestId,
              roomId: yield* decodeRoom(rawRoom, requestId),
              since: sinceParam(url),
              limit: 200,
              thread: null,
            })
          }),
        ),
      )
    }
    if (request.method === "POST" && leaf === "messages") {
      return yield* authed((actor, requestId) =>
        finish(
          Effect.gen(function* () {
            const chat = yield* Chat
            const roomId = yield* decodeRoom(rawRoom, requestId)
            const body = yield* readJson(PostBody, requestId, "body")
            return yield* chat.postMessage({
              actor,
              requestId,
              roomId,
              body: body.body,
              mentions: body.mentions ?? [],
              threadRoot: null,
              replyTo: null,
            })
          }),
        ),
      )
    }
    if (request.method === "GET" && leaf === "threads") {
      return yield* authed((actor, requestId) =>
        finish(
          Effect.gen(function* () {
            const chat = yield* Chat
            return yield* chat.listThreads(actor, requestId, yield* decodeRoom(rawRoom, requestId), 50)
          }),
        ),
      )
    }
  }
  if (request.method === "POST" && path === "/admin/agents") {
    return yield* adminOnly((actor, requestId) =>
      finish(
        Effect.gen(function* () {
          const chat = yield* Chat
          const body = yield* readJson(CreateAgentBody, requestId, "displayName")
          return yield* chat.createAgent(actor, requestId, body.displayName, body.kind, body.webhookUrl ?? null)
        }),
      ),
    )
  }
  if (request.method === "GET" && path === "/admin/agents") {
    return yield* adminOnly((actor, requestId) =>
      finish(
        Effect.gen(function* () {
          const chat = yield* Chat
          return yield* chat.listAgents(actor, requestId)
        }),
      ),
    )
  }
  const rotate = /^\/admin\/agents\/(agent_[0-9a-f]{24})\/rotate$/.exec(path)
  if (request.method === "POST" && rotate?.[1] !== undefined) {
    const rawAgent = rotate[1]
    return yield* adminOnly((actor, requestId) =>
      finish(
        Effect.gen(function* () {
          const chat = yield* Chat
          return yield* chat.rotateToken(actor, requestId, yield* decodeAgent(rawAgent, requestId))
        }),
      ),
    )
  }
  const webhook = /^\/admin\/agents\/(agent_[0-9a-f]{24})\/webhook$/.exec(path)
  if (request.method === "POST" && webhook?.[1] !== undefined) {
    const rawAgent = webhook[1]
    return yield* authed((actor, requestId) =>
      finish(
        Effect.gen(function* () {
          const chat = yield* Chat
          const agentId = yield* decodeAgent(rawAgent, requestId)
          if (actor.agentId !== agentId) return yield* forbidden(requestId)
          const body = yield* readJson(WebhookBody, requestId, "webhookUrl")
          return yield* chat.registerWebhook(actor, requestId, body.webhookUrl)
        }),
      ),
    )
  }
  return yield* notFound
})

const openSession = finishResponse(Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const parsed = yield* Effect.result(HttpServerRequest.schemaBodyJson(SessionBody))
  if (parsed._tag === "Failure") {
    return yield* json(400, {
      code: "InvalidArgument",
      message: "Send JSON { token } to start a viewer session.",
      details: { field: "token", constraint: "string" },
      requestId: internalRequestId,
      retryable: false,
    })
  }
  const actor = yield* loadActor(parsed.success.token)
  const response = yield* json(200, { ok: true, displayName: actor.displayName })
  return yield* Effect.catchTag(
    HttpServerResponse.setCookie(response, "agent_rooms_token", parsed.success.token, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: request.url.startsWith("https://"),
    }),
    "CookiesError",
    () =>
      json(400, {
        code: "InvalidArgument",
        message: "That token could not be stored in a cookie. Use the Authorization header instead.",
        details: { field: "token", constraint: "cookie-safe" },
        requestId: internalRequestId,
        retryable: false,
      }),
  )
}))

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
    compatibility: { flags: ["nodejs_compat"], date: "2026-08-31" },
  },
  Effect.gen(function* () {
    yield* RoomServer
    yield* DirectoryServer
    yield* Config.Redacted("AGENT_ROOMS_ADMIN_TOKEN")
    yield* Config.String("AGENT_ROOMS_ADMIN_NAME").pipe(Config.withDefault("human"))
    // Fetch does not carry the Worker service. Build the clients here, while it does, and close over them.
    const chatServices = yield* Effect.scoped(Layer.build(chatLayer))
    return {
      fetch: dispatch.pipe(Effect.provide(Layer.succeedContext(chatServices))),
    }
  }),
) {}
