import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import type { ChatError } from "../app/chat.ts";
import { publicErrorBody } from "../domain/errors.ts";

export const json = <Body>(status: number, body: Body) =>
  Effect.catchTag(
    HttpServerResponse.json(body, { status }),
    "HttpBodyError",
    () => Effect.die("The response could not be encoded.")
  );

const statusByTag = {
  AgentNotFound: 404,
  Forbidden: 403,
  InvalidArgument: 400,
  LeadRequired: 400,
  MentionRequired: 400,
  MessageNotFound: 404,
  NotAuthor: 403,
  NotInvited: 403,
  NotMember: 403,
  PersistenceFailed: 503,
  RoomNameTaken: 409,
  RoomNotFound: 404,
  SelfMentionOnly: 400,
  Unauthorized: 401,
  Unavailable: 503,
  UnknownMention: 400,
} satisfies Record<ChatError["_tag"], number>;

const statusFor = (error: ChatError): number => statusByTag[error._tag];

const errorResponse = (error: ChatError) =>
  json(statusFor(error), publicErrorBody(error));

const errorCases = {
  AgentNotFound: errorResponse,
  Forbidden: errorResponse,
  InvalidArgument: errorResponse,
  LeadRequired: errorResponse,
  MentionRequired: errorResponse,
  MessageNotFound: errorResponse,
  NotAuthor: errorResponse,
  NotInvited: errorResponse,
  NotMember: errorResponse,
  PersistenceFailed: errorResponse,
  RoomNameTaken: errorResponse,
  RoomNotFound: errorResponse,
  SelfMentionOnly: errorResponse,
  Unauthorized: errorResponse,
  Unavailable: errorResponse,
  UnknownMention: errorResponse,
} satisfies Record<ChatError["_tag"], typeof errorResponse>;

export const finish = <A, R>(effect: Effect.Effect<A, ChatError, R>) =>
  Effect.catchTags(
    Effect.flatMap(effect, (value) => json(200, value)),
    errorCases
  );

export const finishResponse = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, ChatError, R>
) => Effect.catchTags(effect, errorCases);
