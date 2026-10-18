import { DurableObjectState, type WebSocket } from "alchemy/Cloudflare";
import { Effect } from "effect";
import type { MessageView } from "../domain/message.ts";
import { SocketSession } from "./room-sql.ts";

export const restoreRoomSockets = (sessions: Map<string, WebSocket>) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    for (const socket of yield* state.getWebSockets()) {
      const session = yield* socket
        .getAttachment(SocketSession)
        .pipe(
          Effect.catchTag("WebSocketAttachmentError", () =>
            Effect.succeed(undefined)
          )
        );
      if (session === undefined) {
        yield* Effect.exit(socket.close(1000, "stale"));
        continue;
      }
      sessions.set(session.id, socket);
    }
  });

const broadcastRoom = (sessions: Map<string, WebSocket>, text: string) =>
  Effect.gen(function* () {
    for (const socket of sessions.values()) {
      const exit = yield* Effect.exit(socket.send(text));
      if (exit._tag === "Failure") {
        sessions.delete(
          socket.deserializeAttachment<{ id: string }>()?.id ?? ""
        );
      }
    }
  });

export const publishMessage = (
  sessions: Map<string, WebSocket>,
  message: MessageView
) => broadcastRoom(sessions, JSON.stringify({ message, type: "message" }));
