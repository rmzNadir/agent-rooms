import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import type { HttpServerResponse } from "effect/http";
import { finish, finishResponse, json } from "../src/api/respond.ts";
import { parseJson } from "../src/boundary/external.ts";
import {
  InvalidArgument as BadArgument,
  Forbidden as Denied,
  Unavailable as Down,
  AgentNotFound as MissingAgent,
  MessageNotFound as MissingMessage,
  RoomNotFound as MissingRoom,
  RoomNameTaken as NameTaken,
  LeadRequired as NeedsLead,
  MentionRequired as NeedsMention,
  Unauthorized as NoSession,
  NotMember as Outsider,
  SelfMentionOnly as SelfOnly,
  PersistenceFailed as StoreFailed,
  NotAuthor as StrangerAuthor,
  NotInvited as Uninvited,
  UnknownMention as UnknownName,
} from "../src/domain/errors.ts";
import { AgentId, internalRequestId, RoomId } from "../src/domain/ids.ts";

const request = internalRequestId;
const room = Schema.decodeUnknownSync(RoomId)("room_aaaaaaaaaaaaaaaaaaaaaaaa");
const agent = Schema.decodeUnknownSync(AgentId)(
  "agent_aaaaaaaaaaaaaaaaaaaaaaaa"
);

const errors = [
  [
    new NeedsMention({
      code: "MentionRequired",
      details: { roomId: room },
      message: "mention",
      operation: "post_message",
      requestId: request,
      retryable: false,
    }),
    400,
  ],
  [
    new UnknownName({
      code: "UnknownMention",
      details: { roomId: room, token: "nobody" },
      message: "unknown",
      operation: "post_message",
      requestId: request,
      retryable: false,
    }),
    400,
  ],
  [
    new SelfOnly({
      code: "SelfMentionOnly",
      details: { roomId: room },
      message: "self",
      operation: "post_message",
      requestId: request,
      retryable: false,
    }),
    400,
  ],
  [
    new Outsider({
      code: "NotMember",
      details: { roomId: room },
      message: "member",
      operation: "room.access",
      requestId: request,
      retryable: false,
    }),
    403,
  ],
  [
    new Uninvited({
      code: "NotInvited",
      details: { roomId: room },
      message: "invited",
      operation: "join",
      requestId: request,
      retryable: false,
    }),
    403,
  ],
  [
    new StrangerAuthor({
      code: "NotAuthor",
      details: { roomId: room, seq: 2 },
      message: "author",
      operation: "message.mutate",
      requestId: request,
      retryable: false,
    }),
    403,
  ],
  [
    new Denied({
      code: "Forbidden",
      details: {},
      message: "forbidden",
      operation: "admin",
      requestId: request,
      retryable: false,
    }),
    403,
  ],
  [
    new NoSession({
      code: "Unauthorized",
      details: {},
      message: "unauthorized",
      operation: "authenticate",
      requestId: request,
      retryable: false,
    }),
    401,
  ],
  [
    new MissingRoom({
      code: "RoomNotFound",
      details: { roomId: room },
      message: "room",
      operation: "room.read",
      requestId: request,
      retryable: false,
    }),
    404,
  ],
  [
    new MissingMessage({
      code: "MessageNotFound",
      details: { roomId: room, seq: 4 },
      message: "message",
      operation: "message.read",
      requestId: request,
      retryable: false,
    }),
    404,
  ],
  [
    new MissingAgent({
      code: "AgentNotFound",
      details: { agentId: agent },
      message: "agent",
      operation: "agent.read",
      requestId: request,
      retryable: false,
    }),
    404,
  ],
  [
    new NameTaken({
      code: "RoomNameTaken",
      details: { name: "taken" },
      message: "taken",
      operation: "create_room",
      requestId: request,
      retryable: false,
    }),
    409,
  ],
  [
    new NeedsLead({
      code: "LeadRequired",
      details: {},
      message: "lead",
      operation: "create_room",
      requestId: request,
      retryable: false,
    }),
    400,
  ],
  [
    new BadArgument({
      code: "InvalidArgument",
      details: { constraint: "min", field: "limit" },
      message: "argument",
      operation: "read",
      requestId: request,
      retryable: false,
    }),
    400,
  ],
  [
    new StoreFailed({
      code: "PersistenceFailed",
      details: {},
      message: "persist",
      operation: "write",
      requestId: request,
      retryable: true,
    }),
    503,
  ],
  [
    new Down({
      code: "Unavailable",
      details: {},
      message: "down",
      operation: "write",
      requestId: request,
      retryable: true,
    }),
    503,
  ],
] as const;

const OkBody = Schema.Struct({ ok: Schema.Boolean });
const ErrorBody = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
});
const decodeOk = Schema.decodeUnknownSync(OkBody);
const decodeError = Schema.decodeUnknownSync(ErrorBody);

const payload = (response: HttpServerResponse.HttpServerResponse) =>
  response.body._tag === "Uint8Array"
    ? new TextDecoder().decode(response.body.body)
    : "";

test("finish maps each chat error to its public status", async () => {
  const ok = await Effect.runPromise(finish(Effect.succeed({ ok: true })));
  expect(ok.status).toBe(200);
  expect(decodeOk(parseJson(payload(ok)))).toEqual({ ok: true });
  await Promise.all(
    errors.map(async ([error, status]) => {
      const failed = await Effect.runPromise(finish(Effect.fail(error)));
      expect(failed.status).toBe(status);
      expect(decodeError(parseJson(payload(failed)))).toEqual({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      });
      const direct = await Effect.runPromise(
        finishResponse(Effect.fail(error))
      );
      expect(direct.status).toBe(status);
    })
  );
});

test("a value that cannot be encoded dies", async () => {
  const exit = await Effect.runPromiseExit(json(200, { value: BigInt(1) }));
  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") {
    return;
  }
  const [reason] = exit.cause.reasons;
  expect(reason?._tag).toBe("Die");
  if (reason?._tag === "Die") {
    expect(reason.defect).toBe("The response could not be encoded.");
  }
});
