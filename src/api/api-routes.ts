import { Effect } from "effect";
import { Headers, type HttpServerRequest } from "effect/http";
import { Chat } from "../app/chat.ts";
import {
  adminOnly,
  authed,
  CreateAgentBody,
  decodeAgent,
  decodeRoom,
  forbidden,
  handled,
  matchedId,
  PostBody,
  readJson,
  rotatePattern,
  sinceParam,
  skipped,
  WebhookBody,
  webhookPattern,
} from "./access.ts";
import { finish } from "./respond.ts";

const isHandled = <Response>(
  result:
    | { readonly handled: false }
    | { readonly handled: true; readonly response: Response }
): result is { readonly handled: true; readonly response: Response } =>
  result.handled;

const firstHandled = <Response, E, R>(
  routes: readonly Effect.Effect<
    | { readonly handled: false }
    | { readonly handled: true; readonly response: Response },
    E,
    R
  >[]
) =>
  Effect.gen(function* () {
    for (const route of routes) {
      const result = yield* route;
      if (isHandled(result)) {
        return result;
      }
    }
    return skipped;
  });

const routeSocket = (
  request: HttpServerRequest.HttpServerRequest,
  rawRoom: string,
  leaf: string | undefined
) =>
  Effect.gen(function* () {
    if (request.method === "GET" && leaf === "ws") {
      return handled(
        yield* authed((actor, requestId) =>
          Effect.gen(function* () {
            const chat = yield* Chat;
            const roomId = yield* decodeRoom(rawRoom, requestId);
            yield* chat.members(actor, requestId, roomId);
            const stamped = request.modify({
              headers: Headers.set(
                request.headers,
                "x-agent-rooms-agent",
                actor.agentId
              ),
            });
            return yield* chat.forward(roomId, stamped, requestId);
          })
        )
      );
    }
    return skipped;
  });

const routeMessages = (
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  rawRoom: string
) =>
  Effect.gen(function* () {
    if (request.method === "GET") {
      return handled(
        yield* authed((actor, requestId) =>
          finish(
            Effect.gen(function* () {
              const chat = yield* Chat;
              return yield* chat.readMessages({
                actor,
                limit: 200,
                requestId,
                roomId: yield* decodeRoom(rawRoom, requestId),
                since: sinceParam(url),
                thread: null,
              });
            })
          )
        )
      );
    }
    return skipped;
  });

const routePost = (
  request: HttpServerRequest.HttpServerRequest,
  rawRoom: string,
  leaf: string | undefined
) =>
  Effect.gen(function* () {
    if (request.method === "POST" && leaf === "messages") {
      return handled(
        yield* authed((actor, requestId) =>
          finish(
            Effect.gen(function* () {
              const chat = yield* Chat;
              const roomId = yield* decodeRoom(rawRoom, requestId);
              const body = yield* readJson(PostBody, requestId, "body");
              return yield* chat.postMessage({
                actor,
                body: body.body,
                mentions: body.mentions ?? [],
                replyTo: null,
                requestId,
                roomId,
                threadRoot: null,
              });
            })
          )
        )
      );
    }
    return skipped;
  });

const routeThreads = (
  request: HttpServerRequest.HttpServerRequest,
  rawRoom: string,
  leaf: string | undefined
) =>
  Effect.gen(function* () {
    if (request.method === "GET" && leaf === "threads") {
      return handled(
        yield* authed((actor, requestId) =>
          finish(
            Effect.gen(function* () {
              const chat = yield* Chat;
              return yield* chat.listThreads(
                actor,
                requestId,
                yield* decodeRoom(rawRoom, requestId),
                50
              );
            })
          )
        )
      );
    }
    return skipped;
  });

export const routeRoom = (
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  rawRoom: string,
  leaf: string | undefined
) =>
  firstHandled([
    routeSocket(request, rawRoom, leaf),
    routePost(request, rawRoom, leaf),
    routeThreads(request, rawRoom, leaf),
    routeMessages(request, url, rawRoom),
  ]);

const routeCreateAgent = (
  request: HttpServerRequest.HttpServerRequest,
  path: string
) =>
  Effect.gen(function* () {
    if (request.method === "POST" && path === "/admin/agents") {
      return handled(
        yield* adminOnly((actor, requestId) =>
          finish(
            Effect.gen(function* () {
              const chat = yield* Chat;
              const body = yield* readJson(
                CreateAgentBody,
                requestId,
                "displayName"
              );
              return yield* chat.createAgent(
                actor,
                requestId,
                body.displayName,
                body.kind,
                body.webhookUrl ?? null
              );
            })
          )
        )
      );
    }
    return skipped;
  });

const routeListAgents = (
  request: HttpServerRequest.HttpServerRequest,
  path: string
) =>
  Effect.gen(function* () {
    if (request.method === "GET" && path === "/admin/agents") {
      return handled(
        yield* adminOnly((actor, requestId) =>
          finish(
            Effect.gen(function* () {
              const chat = yield* Chat;
              return yield* chat.listAgents(actor, requestId);
            })
          )
        )
      );
    }
    return skipped;
  });

const routeRotate = (
  request: HttpServerRequest.HttpServerRequest,
  path: string
) =>
  Effect.gen(function* () {
    const rotate = rotatePattern.exec(path);
    if (request.method === "POST" && rotate !== null) {
      const rawAgent = matchedId(rotate);
      return handled(
        yield* adminOnly((actor, requestId) =>
          finish(
            Effect.gen(function* () {
              const chat = yield* Chat;
              return yield* chat.rotateToken(
                actor,
                requestId,
                yield* decodeAgent(rawAgent, requestId)
              );
            })
          )
        )
      );
    }
    return skipped;
  });

const routeWebhook = (
  request: HttpServerRequest.HttpServerRequest,
  path: string
) =>
  Effect.gen(function* () {
    const webhook = webhookPattern.exec(path);
    if (request.method === "POST" && webhook !== null) {
      const rawAgent = matchedId(webhook);
      return handled(
        yield* authed((actor, requestId) =>
          finish(
            Effect.gen(function* () {
              const chat = yield* Chat;
              const agentId = yield* decodeAgent(rawAgent, requestId);
              if (actor.agentId !== agentId) {
                return yield* forbidden(requestId);
              }
              const body = yield* readJson(
                WebhookBody,
                requestId,
                "webhookUrl"
              );
              return yield* chat.registerWebhook(
                actor,
                requestId,
                body.webhookUrl
              );
            })
          )
        )
      );
    }
    return skipped;
  });

export const routeAdmin = (
  request: HttpServerRequest.HttpServerRequest,
  path: string
) =>
  firstHandled([
    routeListAgents(request, path),
    routeCreateAgent(request, path),
    routeRotate(request, path),
    routeWebhook(request, path),
  ]);
