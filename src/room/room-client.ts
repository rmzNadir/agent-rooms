import { toHttpClient } from "alchemy/Cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Cache, Context, Effect, Layer } from "effect";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";
import type { HttpServerResponse } from "effect/http/HttpServerResponse";
import { HttpApiClient } from "effect/http-api";
import { roomDown, roomPrepare, roomSettle } from "../api/rpc-client.ts";
import type {
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
} from "../domain/errors.ts";
import type { RequestId, RoomId } from "../domain/ids.ts";
import type {
  MemberView,
  MessagePage,
  MessageView,
  RoomSummary,
  UnreadView,
} from "../domain/message.ts";
import {
  type Ack,
  EditPayload,
  InitRoomPayload,
  InvitePayload,
  JoinPayload,
  LeavePayload,
  MarkReadPayload,
  type MemberList,
  MembersPayload,
  PostPayload,
  ReactPayload,
  ReadPayload,
  RedactPayload,
  RoomHttpApi,
  SearchPayload,
  type ThreadList,
  ThreadsPayload,
  TranscriptPayload,
  type TranscriptResult,
  UnreadPayload,
  WaitPayload,
  WebhookPayload,
} from "./room-http-api.ts";
import RoomServer from "./room-server.ts";

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
  | PersistenceFailed;

export interface IRoomClient {
  readonly edit: (
    roomId: RoomId,
    payload: EditPayload
  ) => Effect.Effect<MessageView, RoomCallError>;
  readonly forward: (
    roomId: RoomId,
    request: HttpServerRequest,
    requestId: RequestId
  ) => Effect.Effect<HttpServerResponse, RoomCallError>;
  readonly init: (
    roomId: RoomId,
    payload: InitRoomPayload
  ) => Effect.Effect<RoomSummary, RoomCallError>;
  readonly invite: (
    roomId: RoomId,
    payload: InvitePayload
  ) => Effect.Effect<MemberView, RoomCallError>;
  readonly join: (
    roomId: RoomId,
    payload: JoinPayload
  ) => Effect.Effect<MemberView, RoomCallError>;
  readonly leave: (
    roomId: RoomId,
    payload: LeavePayload
  ) => Effect.Effect<Ack, RoomCallError>;
  readonly markRead: (
    roomId: RoomId,
    payload: MarkReadPayload
  ) => Effect.Effect<UnreadView, RoomCallError>;
  readonly members: (
    roomId: RoomId,
    payload: MembersPayload
  ) => Effect.Effect<MemberList, RoomCallError>;
  readonly postMessage: (
    roomId: RoomId,
    payload: PostPayload
  ) => Effect.Effect<MessagePage, RoomCallError>;
  readonly react: (
    roomId: RoomId,
    payload: ReactPayload
  ) => Effect.Effect<MessageView, RoomCallError>;
  readonly readMessages: (
    roomId: RoomId,
    payload: ReadPayload
  ) => Effect.Effect<MessagePage, RoomCallError>;
  readonly redact: (
    roomId: RoomId,
    payload: RedactPayload
  ) => Effect.Effect<MessageView, RoomCallError>;
  readonly search: (
    roomId: RoomId,
    payload: SearchPayload
  ) => Effect.Effect<MessagePage, RoomCallError>;
  readonly threads: (
    roomId: RoomId,
    payload: ThreadsPayload
  ) => Effect.Effect<ThreadList, RoomCallError>;
  readonly transcript: (
    roomId: RoomId,
    payload: TranscriptPayload
  ) => Effect.Effect<TranscriptResult, RoomCallError>;
  readonly unread: (
    roomId: RoomId,
    payload: UnreadPayload
  ) => Effect.Effect<UnreadView, RoomCallError>;
  readonly wait: (
    roomId: RoomId,
    payload: WaitPayload
  ) => Effect.Effect<MessagePage, RoomCallError>;
  readonly webhook: (
    roomId: RoomId,
    payload: WebhookPayload
  ) => Effect.Effect<Ack, RoomCallError>;
}

export class RoomClient extends Context.Service<RoomClient, IRoomClient>()(
  "@agent-rooms/RoomClient"
) {}

const makeRoomClient = Effect.gen(function* () {
  const namespace = yield* RoomServer;
  const clients = yield* makeExecutionMemo(
    Cache.make({
      capacity: Number.POSITIVE_INFINITY,
      lookup: (id: RoomId) =>
        Effect.suspend(() =>
          HttpApiClient.makeWith(RoomHttpApi, {
            baseUrl: "http://room.internal",
            httpClient: toHttpClient(namespace.getByName(id)),
          })
        ),
    })
  );

  const roomHttpClient = (roomId: RoomId) =>
    Effect.flatMap(clients, (cache) => Cache.get(cache, roomId));

  return RoomClient.of({
    edit: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* roomPrepare(EditPayload, payload, "edit_message");
        const client = yield* roomHttpClient(roomId);
        return yield* roomSettle(
          client.room.edit({ payload: body }),
          payload.requestId,
          "edit_message"
        );
      }),
    forward: (roomId, request, requestId) =>
      Effect.catchTags(namespace.getByName(roomId).fetch(request), {
        HttpServerError: () => Effect.fail(roomDown(requestId, "room.forward")),
      }),
    init: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* roomPrepare(InitRoomPayload, payload, "room.init");
        const client = yield* roomHttpClient(roomId);
        return yield* roomSettle(
          client.room.init({ payload: body }),
          payload.requestId,
          "room.init"
        );
      }),
    invite: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* roomPrepare(InvitePayload, payload, "invite");
        const client = yield* roomHttpClient(roomId);
        return yield* roomSettle(
          client.room.invite({ payload: body }),
          payload.requestId,
          "invite"
        );
      }),
    join: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* roomPrepare(JoinPayload, payload, "join");
        const client = yield* roomHttpClient(roomId);
        return yield* roomSettle(
          client.room.join({ payload: body }),
          payload.requestId,
          "join"
        );
      }),
    leave: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* roomPrepare(LeavePayload, payload, "leave");
        const client = yield* roomHttpClient(roomId);
        return yield* roomSettle(
          client.room.leave({ payload: body }),
          payload.requestId,
          "leave"
        );
      }),
    markRead: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* roomPrepare(MarkReadPayload, payload, "mark_read");
        const client = yield* roomHttpClient(roomId);
        return yield* roomSettle(
          client.room.markRead({ payload: body }),
          payload.requestId,
          "mark_read"
        );
      }),
    members: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* roomPrepare(MembersPayload, payload, "members");
        const client = yield* roomHttpClient(roomId);
        return yield* roomSettle(
          client.room.members({ payload: body }),
          payload.requestId,
          "members"
        );
      }),
    postMessage: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* roomPrepare(PostPayload, payload, "post_message");
        const client = yield* roomHttpClient(roomId);
        return yield* roomSettle(
          client.room.postMessage({ payload: body }),
          payload.requestId,
          "post_message"
        );
      }),
    react: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* roomPrepare(ReactPayload, payload, "react");
        const client = yield* roomHttpClient(roomId);
        return yield* roomSettle(
          client.room.react({ payload: body }),
          payload.requestId,
          "react"
        );
      }),
    readMessages: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* roomPrepare(ReadPayload, payload, "read_messages");
        const client = yield* roomHttpClient(roomId);
        return yield* roomSettle(
          client.room.readMessages({ payload: body }),
          payload.requestId,
          "read_messages"
        );
      }),
    redact: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* roomPrepare(
          RedactPayload,
          payload,
          "redact_message"
        );
        const client = yield* roomHttpClient(roomId);
        return yield* roomSettle(
          client.room.redact({ payload: body }),
          payload.requestId,
          "redact_message"
        );
      }),
    search: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* roomPrepare(
          SearchPayload,
          payload,
          "search_messages"
        );
        const client = yield* roomHttpClient(roomId);
        return yield* roomSettle(
          client.room.search({ payload: body }),
          payload.requestId,
          "search_messages"
        );
      }),
    threads: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* roomPrepare(
          ThreadsPayload,
          payload,
          "list_threads"
        );
        const client = yield* roomHttpClient(roomId);
        return yield* roomSettle(
          client.room.threads({ payload: body }),
          payload.requestId,
          "list_threads"
        );
      }),
    transcript: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* roomPrepare(
          TranscriptPayload,
          payload,
          "read_transcript"
        );
        const client = yield* roomHttpClient(roomId);
        return yield* roomSettle(
          client.room.transcript({ payload: body }),
          payload.requestId,
          "read_transcript"
        );
      }),
    unread: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* roomPrepare(UnreadPayload, payload, "get_unread");
        const client = yield* roomHttpClient(roomId);
        return yield* roomSettle(
          client.room.unread({ payload: body }),
          payload.requestId,
          "get_unread"
        );
      }),
    wait: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* roomPrepare(
          WaitPayload,
          payload,
          "wait_for_messages"
        );
        const client = yield* roomHttpClient(roomId);
        return yield* roomSettle(
          client.room.wait({ payload: body }),
          payload.requestId,
          "wait_for_messages"
        );
      }),
    webhook: (roomId, payload) =>
      Effect.gen(function* () {
        const body = yield* roomPrepare(
          WebhookPayload,
          payload,
          "register_webhook"
        );
        const client = yield* roomHttpClient(roomId);
        return yield* roomSettle(
          client.room.webhook({ payload: body }),
          payload.requestId,
          "register_webhook"
        );
      }),
  });
});

export const roomClientLayer = Layer.effect(RoomClient, makeRoomClient);
