import {
  DurableObject,
  upgrade as upgradeWebSocket,
  type WebSocket,
} from "alchemy/Cloudflare";
import { Platform } from "alchemy/Http";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { at } from "../boundary/external.ts";
import type { MessageView } from "../domain/message.ts";
import { RoomHttpApi } from "./room-http-api.ts";
import { loadMembers } from "./room-members.ts";
import {
  initRoom,
  invite,
  join,
  leave,
  listMembers,
} from "./room-membership.ts";
import { edit, react, redact, setWebhook } from "./room-mutate.ts";
import { postMessage } from "./room-post.ts";
import {
  markRead,
  readMessages,
  search,
  threads,
  transcript,
  unread,
  wait,
} from "./room-read.ts";
import { publishMessage, restoreRoomSockets } from "./room-socket.ts";
import {
  decodeAgentId,
  type MemberRow,
  migrateRoom,
  SocketSession,
  schemaRequestId,
} from "./room-sql.ts";
import { bindWake, type WakeHandle } from "./room-wake.ts";

export default class RoomServer extends DurableObject<RoomServer>()(
  "RoomServer",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const sessions = new Map<string, WebSocket>();
      yield* migrateRoom;
      yield* restoreRoomSockets(sessions);
      const wake: WakeHandle = { callback: undefined };
      const { enqueue } = yield* bindWake(wake);
      const publish = (message: MessageView) =>
        publishMessage(sessions, message);
      const leaveRoom = leave(sessions);
      const post = postMessage(enqueue, publish);
      const reactTo = react(publish);
      const editMessage = edit(publish);
      const redactMessage = redact(publish);
      const handlers = HttpApiBuilder.group(RoomHttpApi, "room", (group) =>
        group
          .handle("init", ({ payload }) => initRoom(payload))
          .handle("invite", ({ payload }) => invite(payload))
          .handle("join", ({ payload }) => join(payload))
          .handle("leave", ({ payload }) => leaveRoom(payload))
          .handle("members", ({ payload }) => listMembers(payload))
          .handle("postMessage", ({ payload }) => post(payload))
          .handle("readMessages", ({ payload }) => readMessages(payload))
          .handle("transcript", ({ payload }) => transcript(payload))
          .handle("threads", ({ payload }) => threads(payload))
          .handle("search", ({ payload }) => search(payload))
          .handle("wait", ({ payload }) => wait(payload))
          .handle("unread", ({ payload }) => unread(payload))
          .handle("markRead", ({ payload }) => markRead(payload))
          .handle("react", ({ payload }) => reactTo(payload))
          .handle("edit", ({ payload }) => editMessage(payload))
          .handle("redact", ({ payload }) => redactMessage(payload))
          .handle("webhook", ({ payload }) => setWebhook(payload))
      );

      return {
        fetch: Effect.scoped(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const upgrade = at(request.headers, "upgrade");
            if (
              typeof upgrade === "string" &&
              upgrade.toLowerCase() === "websocket"
            ) {
              const header = request.headers["x-agent-rooms-agent"];
              if (typeof header !== "string") {
                return HttpServerResponse.text(
                  "Sign in before opening the room socket.",
                  { status: 401 }
                );
              }
              const agentId = yield* decodeAgentId(header).pipe(
                Effect.catchTag("SchemaError", () =>
                  Effect.succeed("" as const)
                )
              );
              if (agentId === "") {
                return HttpServerResponse.text(
                  "Sign in before opening the room socket.",
                  { status: 401 }
                );
              }
              const members = yield* loadMembers(schemaRequestId).pipe(
                Effect.catchTag("PersistenceFailed", () =>
                  Effect.succeed([] as MemberRow[])
                )
              );
              const member = members.find(
                (item) => item.agentId === agentId && item.joined
              );
              if (member === undefined) {
                return HttpServerResponse.text(
                  "Join the room before opening the socket.",
                  { status: 403 }
                );
              }
              const [response, socket] = yield* upgradeWebSocket();
              const id = crypto.randomUUID();
              yield* socket.setAttachment(SocketSession, { agentId, id });
              sessions.set(id, socket);
              return response;
            }
            const handle = yield* HttpRouter.toHttpEffect(
              HttpApiBuilder.layer(RoomHttpApi).pipe(
                Layer.provide(handlers),
                Layer.provide(Platform)
              )
            );
            return yield* handle;
          })
        ),
        webSocketClose: Effect.fn("RoomServer.webSocketClose")(function* (
          socket: WebSocket
        ) {
          const session = yield* socket
            .getAttachment(SocketSession)
            .pipe(
              Effect.catchTag("WebSocketAttachmentError", () =>
                Effect.succeed(undefined)
              )
            );
          if (session !== undefined) {
            sessions.delete(session.id);
          }
        }),
        webSocketError: Effect.fn("RoomServer.webSocketError")(function* (
          socket: WebSocket
        ) {
          const session = yield* socket
            .getAttachment(SocketSession)
            .pipe(
              Effect.catchTag("WebSocketAttachmentError", () =>
                Effect.succeed(undefined)
              )
            );
          if (session !== undefined) {
            sessions.delete(session.id);
          }
        }),
        webSocketMessage: Effect.fn("RoomServer.webSocketMessage")(function* (
          _socket: WebSocket,
          _message: string | ArrayBuffer
        ) {}),
      };
    });
  })
) {}
