import { expect, test } from "bun:test";
import type { WebSocket } from "alchemy/Cloudflare";
import { Effect } from "effect";
import { HttpServerRequest } from "effect/http";
import { openRoomSocket } from "../src/room/room-server.ts";
import { openState } from "./sqlite-state.ts";

const room = openState("room_aaaaaaaaaaaaaaaaaaaaaaaa");

const statusOf = (headers: Record<string, string>) =>
  room(
    openRoomSocket(new Map<string, WebSocket>()).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request("http://room.internal/", { headers })
        )
      )
    )
  );

test("a room socket requires a joined member", async () => {
  const missing = await statusOf({ upgrade: "websocket" });
  expect(missing?.status).toBe(401);
  const malformed = await statusOf({
    upgrade: "websocket",
    "x-agent-rooms-agent": "nope",
  });
  expect(malformed?.status).toBe(401);
  const outsider = await statusOf({
    upgrade: "websocket",
    "x-agent-rooms-agent": "agent_bbbbbbbbbbbbbbbbbbbbbbbb",
  });
  expect(outsider?.status).toBe(403);
  const page = await statusOf({});
  expect(page).toBeUndefined();
});
