import { Config, Effect, Redacted, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { Chat } from "../app/chat.ts";
import { Actor } from "../domain/actor.ts";
import { Unavailable } from "../domain/errors.ts";
import { internalRequestId } from "../domain/ids.ts";
import { hashToken } from "../domain/token.ts";
import { viewerHtml } from "../viewer/page.ts";
import { isHttps } from "./request-url.ts";
import { finishResponse, json } from "./respond.ts";

const SessionBody = Schema.Struct({ token: Schema.String });

export const fallbackAdminName = "human";

export const absoluteUrl = (value: string) =>
  new URL(value, "http://localhost");

export const locate = (request: { readonly url: string }) =>
  absoluteUrl(request.url);

export const sessionCookie = (secure: boolean) => ({
  httpOnly: true,
  path: "/",
  sameSite: "lax" as const,
  secure,
});

const viewerRoomPattern = /^\/rooms\/(room_[0-9a-f]{24})$/;

const configDown = new Unavailable({
  code: "Unavailable",
  details: {},
  message:
    "The server could not read its admin token. Set AGENT_ROOMS_ADMIN_TOKEN and retry.",
  operation: "authenticate",
  requestId: internalRequestId,
  retryable: true,
});

export const loadActor = (token: string) =>
  Effect.gen(function* () {
    const chat = yield* Chat;
    const adminToken = Redacted.value(
      yield* Effect.catchTag(
        Config.Redacted("AGENT_ROOMS_ADMIN_TOKEN"),
        "ConfigError",
        () => Effect.fail(configDown)
      )
    );
    const adminName = yield* Effect.orDie(
      Config.String("AGENT_ROOMS_ADMIN_NAME").pipe(
        Config.withDefault(fallbackAdminName)
      )
    );
    const tokenHash = yield* hashToken(token);
    const adminHash = yield* hashToken(adminToken);
    const identity = yield* chat.resolve(tokenHash, adminHash, adminName);
    return new Actor({
      admin: identity.admin,
      agentId: identity.agentId,
      displayName: identity.displayName,
      kind: identity.kind,
    });
  });

const openSession = finishResponse(
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const parsed = yield* Effect.result(
      HttpServerRequest.schemaBodyJson(SessionBody)
    );
    if (parsed._tag === "Failure") {
      return yield* json(400, {
        code: "InvalidArgument",
        details: { constraint: "string", field: "token" },
        message: "Send JSON { token } to start a viewer session.",
        requestId: internalRequestId,
        retryable: false,
      });
    }
    const actor = yield* loadActor(parsed.success.token);
    const response = yield* json(200, {
      displayName: actor.displayName,
      ok: true,
    });
    return yield* Effect.orDie(
      HttpServerResponse.setCookie(
        response,
        "agent_rooms_token",
        parsed.success.token,
        sessionCookie(isHttps(request))
      )
    );
  })
);

const skipped = { handled: false as const };

const handled = <Response>(response: Response) => ({
  handled: true as const,
  response,
});

const viewerPage = (roomId: string | null) =>
  HttpServerResponse.text(viewerHtml(roomId), {
    contentType: "text/html; charset=utf-8",
  });

export const routeViewer = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const path = locate(request).pathname;
  if (request.method === "GET" && path === "/health") {
    return handled(yield* json(200, { ok: true }));
  }
  if (request.method === "GET" && (path === "/" || path === "/rooms")) {
    return handled(viewerPage(null));
  }
  const viewerRoom = viewerRoomPattern.exec(path);
  const viewerId = viewerRoom === null ? undefined : viewerRoom[1];
  if (request.method === "GET" && viewerId !== undefined) {
    return handled(viewerPage(viewerId));
  }
  return skipped;
});

export const routePublic = Effect.gen(function* () {
  const viewer = yield* routeViewer;
  if (viewer.handled) {
    return viewer;
  }
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (
    request.method === "POST" &&
    locate(request).pathname === "/viewer/session"
  ) {
    return handled(yield* openSession);
  }
  return skipped;
});
