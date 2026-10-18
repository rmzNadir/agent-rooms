import { Effect, Schema } from "effect";
import { HttpServerRequest, type HttpServerResponse } from "effect/http";
import type { ChatError } from "../app/chat.ts";
import { at } from "../boundary/external.ts";
import type { Actor } from "../domain/actor.ts";
import { Forbidden, InvalidArgument, Unauthorized } from "../domain/errors.ts";
import {
  AgentId,
  internalRequestId,
  makeRequestId,
  type RequestId,
  RoomId,
} from "../domain/ids.ts";
import { finishResponse, json } from "./respond.ts";
import { loadActor } from "./session.ts";

export const PostBody = Schema.Struct({
  body: Schema.String,
  mentions: Schema.optional(Schema.Array(Schema.String)),
});
export const CreateAgentBody = Schema.Struct({
  displayName: Schema.String,
  kind: Schema.Literals(["agent", "human"]),
  webhookUrl: Schema.optional(Schema.NullOr(Schema.String)),
});
export const WebhookBody = Schema.Struct({
  webhookUrl: Schema.NullOr(Schema.String),
});

const bearerPattern = /^Bearer\s+(\S+)$/i;
export const roomApiPattern =
  /^\/api\/rooms\/(room_[0-9a-f]{24})(?:\/(messages|threads|ws))?$/;
export const rotatePattern = /^\/admin\/agents\/(agent_[0-9a-f]{24})\/rotate$/;
export const webhookPattern =
  /^\/admin\/agents\/(agent_[0-9a-f]{24})\/webhook$/;

const tokenFrom = (request: HttpServerRequest.HttpServerRequest) => {
  const header = at(request.headers, "authorization");
  if (typeof header === "string") {
    const match = bearerPattern.exec(header);
    const [, bearer] = match ?? [];
    if (bearer !== undefined && bearer.length > 0) {
      return bearer;
    }
  }
  return at(request.cookies, "agent_rooms_token") ?? "";
};

const requestIdOf = Effect.catchTag(makeRequestId(), "SchemaError", () =>
  Effect.succeed(internalRequestId)
);

const unauthorized = (requestId: RequestId) =>
  new Unauthorized({
    code: "Unauthorized",
    details: {},
    message: "Send a bearer token for an agent, or the admin token.",
    operation: "authenticate",
    requestId,
    retryable: false,
  });

export const forbidden = (requestId: RequestId) =>
  new Forbidden({
    code: "Forbidden",
    details: {},
    message: "That action needs the admin token. Retry with the admin bearer.",
    operation: "admin",
    requestId,
    retryable: false,
  });

export const authed = <R>(
  run: (
    actor: Actor,
    requestId: RequestId
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, ChatError, R>
) =>
  finishResponse(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const requestId = yield* requestIdOf;
      const token = tokenFrom(request);
      if (token.length === 0) {
        return yield* unauthorized(requestId);
      }
      const actor = yield* loadActor(token);
      return yield* run(actor, requestId);
    })
  );

export const adminOnly = <R>(
  run: (
    actor: Actor,
    requestId: RequestId
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, ChatError, R>
) =>
  authed((actor, requestId) =>
    actor.admin ? run(actor, requestId) : Effect.fail(forbidden(requestId))
  );

const badRoom = (requestId: RequestId) =>
  new InvalidArgument({
    code: "InvalidArgument",
    details: { constraint: "room_[24 hex]", field: "room" },
    message: "room must be a room id. Check the path and retry.",
    operation: "room.read",
    requestId,
    retryable: false,
  });

const badBody = (requestId: RequestId, field: string) =>
  new InvalidArgument({
    code: "InvalidArgument",
    details: { constraint: "json", field },
    message: `${field} could not be read. Send the JSON body described in the README and retry.`,
    operation: "http.body",
    requestId,
    retryable: false,
  });

export const decodeRoom = (value: string, requestId: RequestId) =>
  Effect.catchTag(
    Schema.decodeUnknownEffect(RoomId)(value),
    "SchemaError",
    () => Effect.fail(badRoom(requestId))
  );

export const decodeAgent = (value: string, requestId: RequestId) =>
  Effect.catchTag(
    Schema.decodeUnknownEffect(AgentId)(value),
    "SchemaError",
    () =>
      Effect.fail(
        new InvalidArgument({
          code: "InvalidArgument",
          details: { constraint: "agent_[24 hex]", field: "agentId" },
          message:
            "agent id must look like agent_ plus 24 hex characters. Check it and retry.",
          operation: "admin",
          requestId,
          retryable: false,
        })
      )
  );

export const readJson = <A>(
  schema: Schema.Decoder<A>,
  requestId: RequestId,
  field: string
) =>
  Effect.catchTags(HttpServerRequest.schemaBodyJson(schema), {
    HttpServerError: () => Effect.fail(badBody(requestId, field)),
    SchemaError: () => Effect.fail(badBody(requestId, field)),
  });

export const sinceParam = (url: URL) => {
  const raw = url.searchParams.get("since");
  return raw === null ? 0 : Number(raw);
};

export const notFound = json(404, {
  code: "NotFound",
  details: {},
  message: "That path is not served. Use /mcp, /health, or the viewer.",
  requestId: internalRequestId,
  retryable: false,
});

export const skipped = { handled: false as const };
export const handled = <Response>(response: Response) => ({
  handled: true as const,
  response,
});
