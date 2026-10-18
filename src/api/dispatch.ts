import { Effect } from "effect";
import { HttpServerRequest } from "effect/http";
import { Chat } from "../app/chat.ts";
import { handleMcp } from "../mcp/handler.ts";
import { authed, notFound, roomApiPattern } from "./access.ts";
import { routeAdmin, routeRoom } from "./api-routes.ts";
import { finish } from "./respond.ts";
import { locate, routePublic } from "./session.ts";

export const dispatch = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = locate(request);
  const path = url.pathname;
  const front = yield* routePublic;
  if (front.handled) {
    return front.response;
  }
  if (request.method === "POST" && path === "/mcp") {
    return yield* authed((actor) => handleMcp(actor));
  }
  if (request.method === "GET" && path === "/api/whoami") {
    return yield* authed((actor) =>
      finish(
        Effect.gen(function* () {
          const chat = yield* Chat;
          return chat.whoami(actor);
        })
      )
    );
  }
  if (request.method === "GET" && path === "/api/rooms") {
    return yield* authed((actor, requestId) =>
      finish(
        Effect.gen(function* () {
          const chat = yield* Chat;
          return yield* chat.listRooms(actor, requestId);
        })
      )
    );
  }
  const roomApi = roomApiPattern.exec(path);
  if (roomApi !== null) {
    const routed = yield* routeRoom(
      request,
      url,
      roomApi[1] as string,
      roomApi[2]
    );
    if (routed.handled) {
      return routed.response;
    }
  }
  const admin = yield* routeAdmin(request, path);
  if (admin.handled) {
    return admin.response;
  }
  return yield* notFound;
});
