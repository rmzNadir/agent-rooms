import { expect, test } from "bun:test";
import { Effect } from "effect";
import { HttpServerRequest } from "effect/http";
import { routeViewer } from "../src/api/session.ts";

const respond = (url: string, method = "GET") =>
  Effect.runPromise(
    routeViewer.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(url, { method }))
      )
    )
  );

test("public routes serve health and the viewer without a session", async () => {
  const health = await respond("http://localhost/health");
  expect(health.handled).toBe(true);
  if (!health.handled) {
    throw new Error("The health route was not handled.");
  }
  expect(health.response.status).toBe(200);
  const home = await respond("http://localhost/");
  expect(home.handled).toBe(true);
  const index = await respond("http://localhost/rooms");
  expect(index.handled).toBe(true);
  const room = await respond(
    "http://localhost/rooms/room_aaaaaaaaaaaaaaaaaaaaaaaa"
  );
  expect(room.handled).toBe(true);
  const other = await respond("http://localhost/nope", "POST");
  expect(other.handled).toBe(false);
  const postedHealth = await respond("http://localhost/health", "POST");
  expect(postedHealth.handled).toBe(false);
  const postedHome = await respond("http://localhost/", "POST");
  expect(postedHome.handled).toBe(false);
  const postedRoom = await respond(
    "http://localhost/rooms/room_aaaaaaaaaaaaaaaaaaaaaaaa",
    "POST"
  );
  expect(postedRoom.handled).toBe(false);
});
