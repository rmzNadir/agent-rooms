import { expect, test } from "bun:test";
import { Effect } from "effect";
import { HttpServerRequest } from "effect/http";
import { dispatch } from "../src/api/dispatch.ts";
import { Chat, type IChat } from "../src/app/chat.ts";
import { asService } from "./sqlite-state.ts";

const quietChat = asService<IChat>(
  new Proxy(
    {},
    {
      get: () => () => Effect.die("This route does not call the chat service."),
    }
  )
);

const respond = (url: string, method: string) =>
  Effect.runPromise(
    dispatch.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(url, { method }))
      ),
      Effect.provideService(Chat, quietChat)
    )
  );

test("public and unauthenticated routes keep their status codes", async () => {
  const health = await respond("http://localhost/health", "GET");
  expect(health.status).toBe(200);
  const mcp = await respond("http://localhost/mcp", "POST");
  expect(mcp.status).toBe(401);
  const whoami = await respond("http://localhost/api/whoami", "GET");
  expect(whoami.status).toBe(401);
  const rooms = await respond("http://localhost/api/rooms", "GET");
  expect(rooms.status).toBe(401);
  const messages = await respond(
    "http://localhost/api/rooms/room_aaaaaaaaaaaaaaaaaaaaaaaa/messages",
    "GET"
  );
  expect(messages.status).toBe(401);
  const threads = await respond(
    "http://localhost/api/rooms/room_aaaaaaaaaaaaaaaaaaaaaaaa/threads",
    "GET"
  );
  expect(threads.status).toBe(401);
  const socket = await respond(
    "http://localhost/api/rooms/room_aaaaaaaaaaaaaaaaaaaaaaaa/ws",
    "GET"
  );
  expect(socket.status).toBe(401);
  const posted = await respond(
    "http://localhost/api/rooms/room_aaaaaaaaaaaaaaaaaaaaaaaa/messages",
    "POST"
  );
  expect(posted.status).toBe(401);
  const created = await respond("http://localhost/admin/agents", "POST");
  expect(created.status).toBe(401);
  const listed = await respond("http://localhost/admin/agents", "GET");
  expect(listed.status).toBe(401);
  const rotated = await respond(
    "http://localhost/admin/agents/agent_aaaaaaaaaaaaaaaaaaaaaaaa/rotate",
    "POST"
  );
  expect(rotated.status).toBe(401);
  const webhook = await respond(
    "http://localhost/admin/agents/agent_aaaaaaaaaaaaaaaaaaaaaaaa/webhook",
    "POST"
  );
  expect(webhook.status).toBe(401);
  const missing = await respond("http://localhost/nope", "GET");
  expect(missing.status).toBe(404);
  const mcpGet = await respond("http://localhost/mcp", "GET");
  expect(mcpGet.status).toBe(404);
  const whoamiPost = await respond("http://localhost/api/whoami", "POST");
  expect(whoamiPost.status).toBe(404);
  const roomsPost = await respond("http://localhost/api/rooms", "POST");
  expect(roomsPost.status).toBe(404);
  const bareRoom = await respond(
    "http://localhost/api/rooms/room_aaaaaaaaaaaaaaaaaaaaaaaa",
    "POST"
  );
  expect(bareRoom.status).toBe(404);
});
