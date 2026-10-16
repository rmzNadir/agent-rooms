import * as Cloudflare from "alchemy/Cloudflare"
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo"
import { Cache, Context, Effect, Layer, Schema } from "effect"
import type { HttpClientError } from "effect/http/HttpClientError"
import type { HttpServerRequest } from "effect/http/HttpServerRequest"
import type { HttpServerResponse } from "effect/http/HttpServerResponse"
import { HttpApiClient } from "effect/http-api"
import {
  Forbidden,
  InvalidArgument,
  MentionRequired,
  MessageNotFound,
  NotAuthor,
  NotInvited,
  NotMember,
  PersistenceFailed,
  RoomNotFound,
  SelfMentionOnly,
  Unavailable,
  UnknownMention,
} from "../domain/errors.ts"
import type { RequestId, RoomId } from "../domain/ids.ts"
import type { MemberView, MessagePage, MessageView, RoomSummary, UnreadView } from "../domain/message.ts"
import {
  Ack,
  EditPayload,
  InitRoomPayload,
  InvitePayload,
  JoinPayload,
  LeavePayload,
  MarkReadPayload,
  MemberList,
  MembersPayload,
  PostPayload,
  ReactPayload,
  ReadPayload,
  RedactPayload,
  RoomHttpApi,
  SearchPayload,
  ThreadList,
  ThreadsPayload,
  TranscriptPayload,
  type TranscriptResult,
  UnreadPayload,
  WaitPayload,
  WebhookPayload,
} from "./room-http-api.ts"
import RoomServer from "./room-server.ts"

export type RoomCallError =
  | Unavailable
  | MentionRequired
  | UnknownMention
  | SelfMentionOnly
  | NotMember
  | NotInvited
  | NotAuthor
  | Forbidden
  | RoomNotFound
  | MessageNotFound
  | InvalidArgument
  | PersistenceFailed

type TransportError = RoomCallError | HttpClientError | Schema.SchemaError

const down = (requestId: RequestId, operation: string) =>
  new Unavailable({
    code: "Unavailable",
    operation,
    message: "The room did not respond. Retry the same request.",
    requestId,
    details: {},
    retryable: true,
  })

const settle = <A>(effect: Effect.Effect<A, TransportError>, requestId: RequestId, operation: string) =>
  Effect.catchTags(effect, {
    HttpClientError: () => Effect.fail(down(requestId, operation)),
    SchemaError: () => Effect.fail(down(requestId, operation)),
  })

const prepare = <A>(schema: Schema.Decoder<A>, payload: { readonly requestId: RequestId }, operation: string) =>
  Effect.catchTag(Schema.decodeUnknownEffect(schema)(payload), "SchemaError", () =>
    Effect.fail(down(payload.requestId, operation)),
  )

export interface IRoomClient {
  readonly init: (roomId: RoomId, payload: InitRoomPayload) => Effect.Effect<RoomSummary, RoomCallError>
  readonly postMessage: (roomId: RoomId, payload: PostPayload) => Effect.Effect<MessagePage, RoomCallError>
  readonly readMessages: (roomId: RoomId, payload: ReadPayload) => Effect.Effect<MessagePage, RoomCallError>
  readonly transcript: (roomId: RoomId, payload: TranscriptPayload) => Effect.Effect<TranscriptResult, RoomCallError>
  readonly threads: (roomId: RoomId, payload: ThreadsPayload) => Effect.Effect<ThreadList, RoomCallError>
  readonly search: (roomId: RoomId, payload: SearchPayload) => Effect.Effect<MessagePage, RoomCallError>
  readonly wait: (roomId: RoomId, payload: WaitPayload) => Effect.Effect<MessagePage, RoomCallError>
  readonly unread: (roomId: RoomId, payload: UnreadPayload) => Effect.Effect<UnreadView, RoomCallError>
  readonly markRead: (roomId: RoomId, payload: MarkReadPayload) => Effect.Effect<UnreadView, RoomCallError>
  readonly react: (roomId: RoomId, payload: ReactPayload) => Effect.Effect<MessageView, RoomCallError>
  readonly edit: (roomId: RoomId, payload: EditPayload) => Effect.Effect<MessageView, RoomCallError>
  readonly redact: (roomId: RoomId, payload: RedactPayload) => Effect.Effect<MessageView, RoomCallError>
  readonly invite: (roomId: RoomId, payload: InvitePayload) => Effect.Effect<MemberView, RoomCallError>
  readonly join: (roomId: RoomId, payload: JoinPayload) => Effect.Effect<MemberView, RoomCallError>
  readonly leave: (roomId: RoomId, payload: LeavePayload) => Effect.Effect<Ack, RoomCallError>
  readonly members: (roomId: RoomId, payload: MembersPayload) => Effect.Effect<MemberList, RoomCallError>
  readonly webhook: (roomId: RoomId, payload: WebhookPayload) => Effect.Effect<Ack, RoomCallError>
  readonly forward: (
    roomId: RoomId,
    request: HttpServerRequest,
    requestId: RequestId,
  ) => Effect.Effect<HttpServerResponse, RoomCallError>
}

export class RoomClient extends Context.Service<RoomClient, IRoomClient>()("@agent-rooms/RoomClient") {}

export const makeRoomClient = Effect.gen(function* () {
  const namespace = yield* RoomServer
  const clients = yield* makeExecutionMemo(
    Cache.make({
      capacity: Number.POSITIVE_INFINITY,
      lookup: (id: RoomId) =>
        Effect.suspend(() =>
          HttpApiClient.makeWith(RoomHttpApi, {
            baseUrl: "http://room.internal",
            httpClient: Cloudflare.toHttpClient(namespace.getByName(id)),
          }),
        ),
    }),
  )

  const roomHttpClient = (roomId: RoomId) => Effect.flatMap(clients, (cache) => Cache.get(cache, roomId))

  return RoomClient.of({
    init: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(InitRoomPayload, payload, "room.init")
        const client = yield* roomHttpClient(roomId)
        return yield* settle(client.room.init({ payload: body }), payload.requestId, "room.init")
      }),
    postMessage: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(PostPayload, payload, "post_message")
        const client = yield* roomHttpClient(roomId)
        return yield* settle(client.room.postMessage({ payload: body }), payload.requestId, "post_message")
      }),
    readMessages: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(ReadPayload, payload, "read_messages")
        const client = yield* roomHttpClient(roomId)
        return yield* settle(client.room.readMessages({ payload: body }), payload.requestId, "read_messages")
      }),
    transcript: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(TranscriptPayload, payload, "read_transcript")
        const client = yield* roomHttpClient(roomId)
        return yield* settle(client.room.transcript({ payload: body }), payload.requestId, "read_transcript")
      }),
    threads: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(ThreadsPayload, payload, "list_threads")
        const client = yield* roomHttpClient(roomId)
        return yield* settle(client.room.threads({ payload: body }), payload.requestId, "list_threads")
      }),
    search: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(SearchPayload, payload, "search_messages")
        const client = yield* roomHttpClient(roomId)
        return yield* settle(client.room.search({ payload: body }), payload.requestId, "search_messages")
      }),
    wait: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(WaitPayload, payload, "wait_for_messages")
        const client = yield* roomHttpClient(roomId)
        return yield* settle(client.room.wait({ payload: body }), payload.requestId, "wait_for_messages")
      }),
    unread: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(UnreadPayload, payload, "get_unread")
        const client = yield* roomHttpClient(roomId)
        return yield* settle(client.room.unread({ payload: body }), payload.requestId, "get_unread")
      }),
    markRead: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(MarkReadPayload, payload, "mark_read")
        const client = yield* roomHttpClient(roomId)
        return yield* settle(client.room.markRead({ payload: body }), payload.requestId, "mark_read")
      }),
    react: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(ReactPayload, payload, "react")
        const client = yield* roomHttpClient(roomId)
        return yield* settle(client.room.react({ payload: body }), payload.requestId, "react")
      }),
    edit: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(EditPayload, payload, "edit_message")
        const client = yield* roomHttpClient(roomId)
        return yield* settle(client.room.edit({ payload: body }), payload.requestId, "edit_message")
      }),
    redact: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(RedactPayload, payload, "redact_message")
        const client = yield* roomHttpClient(roomId)
        return yield* settle(client.room.redact({ payload: body }), payload.requestId, "redact_message")
      }),
    invite: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(InvitePayload, payload, "invite")
        const client = yield* roomHttpClient(roomId)
        return yield* settle(client.room.invite({ payload: body }), payload.requestId, "invite")
      }),
    join: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(JoinPayload, payload, "join")
        const client = yield* roomHttpClient(roomId)
        return yield* settle(client.room.join({ payload: body }), payload.requestId, "join")
      }),
    leave: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(LeavePayload, payload, "leave")
        const client = yield* roomHttpClient(roomId)
        return yield* settle(client.room.leave({ payload: body }), payload.requestId, "leave")
      }),
    members: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(MembersPayload, payload, "members")
        const client = yield* roomHttpClient(roomId)
        return yield* settle(client.room.members({ payload: body }), payload.requestId, "members")
      }),
    webhook: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* prepare(WebhookPayload, payload, "register_webhook")
        const client = yield* roomHttpClient(roomId)
        return yield* settle(client.room.webhook({ payload: body }), payload.requestId, "register_webhook")
      }),
    forward: (roomId, request, requestId) =>
      Effect.catchTags(namespace.getByName(roomId).fetch(request), {
        HttpServerError: () => Effect.fail(down(requestId, "room.forward")),
      }),
  })
})

export const roomClientLayer = Layer.effect(RoomClient, makeRoomClient)
