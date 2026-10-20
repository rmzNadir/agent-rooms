import { expect, test } from "bun:test";
import { Schema } from "effect";
import { type AST, resolveAt } from "effect/SchemaAST";
import {
  AgentNotFound,
  Forbidden,
  InvalidArgument,
  LeadRequired,
  MentionRequired,
  MessageNotFound,
  NotAuthor,
  NotInvited,
  NotMember,
  PersistenceFailed,
  publicErrorBody,
  RoomNameTaken,
  RoomNotFound,
  SelfMentionOnly,
  Unauthorized,
  Unavailable,
  UnknownMention,
} from "../src/domain/errors.ts";
import { AgentId, internalRequestId, RoomId } from "../src/domain/ids.ts";

const requestId = internalRequestId;
const roomId = Schema.decodeUnknownSync(RoomId)(
  "room_aaaaaaaaaaaaaaaaaaaaaaaa"
);
const agentId = Schema.decodeUnknownSync(AgentId)(
  "agent_aaaaaaaaaaaaaaaaaaaaaaaa"
);

const statusOf = (schema: { readonly ast: AST }) =>
  resolveAt("httpApiStatus")(schema.ast);

const claim = (ok: boolean) => {
  if (!ok) {
    throw new Error("schema claim failed");
  }
};

const same = (decoded: object, value: object) => {
  const record = decoded as Record<
    string,
    string | number | boolean | null | object
  >;
  const expected = value as Record<
    string,
    string | number | boolean | null | object
  >;
  for (const key of Object.keys(expected)) {
    if (JSON.stringify(record[key]) !== JSON.stringify(expected[key])) {
      return false;
    }
  }
  return true;
};

const trip = <
  Value extends {
    readonly _tag: string;
    readonly code: string;
    readonly details: object;
    readonly message: string;
    readonly operation: string;
    readonly requestId: typeof requestId;
    readonly retryable: boolean;
  },
>(
  encode: (value: Value) => object,
  decode: (value: object) => Value,
  schema: { readonly ast: AST },
  value: Value,
  tag: string,
  status: number
): Value => {
  const encoded = JSON.parse(JSON.stringify(encode(value))) as object;
  const decoded = decode(encoded);
  claim(
    same(decoded, {
      _tag: tag,
      code: value.code,
      message: value.message,
      operation: value.operation,
      requestId: value.requestId,
      retryable: value.retryable,
    })
  );
  if (Object.keys(value.details).length > 0) {
    let rejected = false;
    try {
      decode({ ...encoded, details: {} });
    } catch {
      rejected = true;
    }
    claim(rejected);
  }
  claim(statusOf(schema) === status);
  claim(
    same(publicErrorBody(value), {
      code: value.code,
      message: value.message,
      requestId: value.requestId,
      retryable: value.retryable,
    })
  );
  return decoded;
};

test("tagged errors keep their code, status, and details through the schema", () => {
  const mention = trip(
    Schema.encodeSync(MentionRequired),
    Schema.decodeUnknownSync(MentionRequired, { onExcessProperty: "error" }),
    MentionRequired,
    new MentionRequired({
      code: "MentionRequired",
      details: { roomId },
      message: "mention",
      operation: "post_message",
      requestId,
      retryable: false,
    }),
    "MentionRequired",
    400
  );
  expect(mention.details.roomId).toBe(roomId);
  const unmentioned = trip(
    Schema.encodeSync(UnknownMention),
    Schema.decodeUnknownSync(UnknownMention, { onExcessProperty: "error" }),
    UnknownMention,
    new UnknownMention({
      code: "UnknownMention",
      details: { roomId, token: "nobody" },
      message: "unknown",
      operation: "post_message",
      requestId,
      retryable: false,
    }),
    "UnknownMention",
    400
  );
  expect(unmentioned.details.token).toBe("nobody");
  const self = trip(
    Schema.encodeSync(SelfMentionOnly),
    Schema.decodeUnknownSync(SelfMentionOnly, { onExcessProperty: "error" }),
    SelfMentionOnly,
    new SelfMentionOnly({
      code: "SelfMentionOnly",
      details: { roomId },
      message: "self",
      operation: "post_message",
      requestId,
      retryable: false,
    }),
    "SelfMentionOnly",
    400
  );
  expect(self.details.roomId).toBe(roomId);
  const member = trip(
    Schema.encodeSync(NotMember),
    Schema.decodeUnknownSync(NotMember, { onExcessProperty: "error" }),
    NotMember,
    new NotMember({
      code: "NotMember",
      details: { roomId },
      message: "member",
      operation: "room.access",
      requestId,
      retryable: false,
    }),
    "NotMember",
    403
  );
  expect(member.details.roomId).toBe(roomId);
  const invited = trip(
    Schema.encodeSync(NotInvited),
    Schema.decodeUnknownSync(NotInvited, { onExcessProperty: "error" }),
    NotInvited,
    new NotInvited({
      code: "NotInvited",
      details: { roomId },
      message: "invited",
      operation: "join",
      requestId,
      retryable: false,
    }),
    "NotInvited",
    403
  );
  expect(invited.details.roomId).toBe(roomId);
  const author = trip(
    Schema.encodeSync(NotAuthor),
    Schema.decodeUnknownSync(NotAuthor, { onExcessProperty: "error" }),
    NotAuthor,
    new NotAuthor({
      code: "NotAuthor",
      details: { roomId, seq: 2 },
      message: "author",
      operation: "message.mutate",
      requestId,
      retryable: false,
    }),
    "NotAuthor",
    403
  );
  expect(author.details.seq).toBe(2);
  trip(
    Schema.encodeSync(Forbidden),
    Schema.decodeUnknownSync(Forbidden, { onExcessProperty: "error" }),
    Forbidden,
    new Forbidden({
      code: "Forbidden",
      details: {},
      message: "forbidden",
      operation: "admin",
      requestId,
      retryable: false,
    }),
    "Forbidden",
    403
  );
  trip(
    Schema.encodeSync(Unauthorized),
    Schema.decodeUnknownSync(Unauthorized, { onExcessProperty: "error" }),
    Unauthorized,
    new Unauthorized({
      code: "Unauthorized",
      details: {},
      message: "unauthorized",
      operation: "authenticate",
      requestId,
      retryable: false,
    }),
    "Unauthorized",
    401
  );
  const missingRoom = trip(
    Schema.encodeSync(RoomNotFound),
    Schema.decodeUnknownSync(RoomNotFound, { onExcessProperty: "error" }),
    RoomNotFound,
    new RoomNotFound({
      code: "RoomNotFound",
      details: { roomId },
      message: "room",
      operation: "room.read",
      requestId,
      retryable: false,
    }),
    "RoomNotFound",
    404
  );
  expect(missingRoom.details.roomId).toBe(roomId);
  const missingMessage = trip(
    Schema.encodeSync(MessageNotFound),
    Schema.decodeUnknownSync(MessageNotFound, { onExcessProperty: "error" }),
    MessageNotFound,
    new MessageNotFound({
      code: "MessageNotFound",
      details: { roomId, seq: 4 },
      message: "message",
      operation: "message.read",
      requestId,
      retryable: false,
    }),
    "MessageNotFound",
    404
  );
  expect(missingMessage.details.seq).toBe(4);
  const missingAgent = trip(
    Schema.encodeSync(AgentNotFound),
    Schema.decodeUnknownSync(AgentNotFound, { onExcessProperty: "error" }),
    AgentNotFound,
    new AgentNotFound({
      code: "AgentNotFound",
      details: { agentId },
      message: "agent",
      operation: "agent.read",
      requestId,
      retryable: false,
    }),
    "AgentNotFound",
    404
  );
  expect(missingAgent.details.agentId).toBe(agentId);
  const taken = trip(
    Schema.encodeSync(RoomNameTaken),
    Schema.decodeUnknownSync(RoomNameTaken, { onExcessProperty: "error" }),
    RoomNameTaken,
    new RoomNameTaken({
      code: "RoomNameTaken",
      details: { name: "ops" },
      message: "taken",
      operation: "create_room",
      requestId,
      retryable: false,
    }),
    "RoomNameTaken",
    409
  );
  expect(taken.details.name).toBe("ops");
  trip(
    Schema.encodeSync(LeadRequired),
    Schema.decodeUnknownSync(LeadRequired, { onExcessProperty: "error" }),
    LeadRequired,
    new LeadRequired({
      code: "LeadRequired",
      details: {},
      message: "lead",
      operation: "create_room",
      requestId,
      retryable: false,
    }),
    "LeadRequired",
    400
  );
  const invalid = trip(
    Schema.encodeSync(InvalidArgument),
    Schema.decodeUnknownSync(InvalidArgument, { onExcessProperty: "error" }),
    InvalidArgument,
    new InvalidArgument({
      code: "InvalidArgument",
      details: { constraint: "json", field: "body" },
      message: "bad",
      operation: "http.body",
      requestId,
      retryable: false,
    }),
    "InvalidArgument",
    400
  );
  expect(invalid.details).toEqual({ constraint: "json", field: "body" });
  const failed = trip(
    Schema.encodeSync(PersistenceFailed),
    Schema.decodeUnknownSync(PersistenceFailed, { onExcessProperty: "error" }),
    PersistenceFailed,
    new PersistenceFailed({
      code: "PersistenceFailed",
      details: {},
      message: "again",
      operation: "room.sql",
      requestId,
      retryable: true,
    }),
    "PersistenceFailed",
    503
  );
  expect(failed.retryable).toBe(true);
  const down = trip(
    Schema.encodeSync(Unavailable),
    Schema.decodeUnknownSync(Unavailable, { onExcessProperty: "error" }),
    Unavailable,
    new Unavailable({
      code: "Unavailable",
      details: {},
      message: "down",
      operation: "authenticate",
      requestId,
      retryable: true,
    }),
    "Unavailable",
    503
  );
  expect(down.retryable).toBe(true);
});
