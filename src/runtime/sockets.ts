import { Context, Effect, Layer } from "effect";
import type { HttpServerRequest } from "effect/http";
import { HttpServerResponse } from "effect/http";

export interface RoomSocketApi {
  readonly close: (roomId: string, agentId: string) => Effect.Effect<void>;
  readonly open: (
    roomId: string,
    request: HttpServerRequest.HttpServerRequest
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
  readonly publish: (roomId: string, text: string) => Effect.Effect<void>;
}

export class RoomSockets extends Context.Service<RoomSockets, RoomSocketApi>()(
  "@agent-rooms/RoomSockets"
) {}

export const socketsSkip = Layer.succeed(
  RoomSockets,
  RoomSockets.of({
    close: () => Effect.void,
    open: () =>
      Effect.succeed(
        HttpServerResponse.text(
          "Open the room socket with a websocket upgrade.",
          { status: 400 }
        )
      ),
    publish: () => Effect.void,
  })
);
