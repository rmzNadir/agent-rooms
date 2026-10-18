import { expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { Effect, Schema, type Tracer } from "effect";
import {
  Actor,
  DisplayName,
  MemberKind,
  RoomName,
} from "../src/domain/actor.ts";
import {
  AgentId,
  makeAgentId,
  makeRequestId,
  makeRoomId,
  RequestId,
  RoomId,
} from "../src/domain/ids.ts";
import {
  IdentityView,
  MemberView,
  MessagePage,
  MessageView,
  ReactionView,
  RoomSummary,
  ThreadSummary,
  UnreadView,
} from "../src/domain/message.ts";
import { socketIdsForAgent } from "../src/domain/sockets.ts";
import { execRows } from "../src/domain/sql-exec.ts";
import { sqlRow } from "../src/domain/sql-row.ts";
import {
  decodeStoredJson,
  hashToken,
  makeSecret,
  signPayload,
} from "../src/domain/token.ts";
import { openState } from "./sqlite-state.ts";

const names: string[] = [];
const ignore = () => undefined;
const roomIdPattern = /^room_[0-9a-f]{24}$/;
const agentIdPattern = /^agent_[0-9a-f]{24}$/;
const requestIdPattern = /^req_[0-9a-f]{24}$/;
const secretPattern = /^[0-9a-f]{64}$/;

const tracer: Tracer.Tracer = {
  span(options: Parameters<Tracer.Tracer["span"]>[0]) {
    names.push(options.name);
    return {
      _tag: "Span",
      addLinks: ignore,
      annotations: options.annotations,
      attribute: ignore,
      attributes: new Map(),
      end: ignore,
      event: ignore,
      kind: options.kind,
      links: options.links,
      name: options.name,
      parent: options.parent,
      sampled: options.sampled,
      spanId: "span",
      status: { _tag: "Started", startTime: options.startTime },
      traceId: "trace",
    };
  },
};

const traced = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.withTracer(tracer)));

const reject = (run: () => void) => {
  let rejected = false;
  try {
    run();
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
};

type Field = string | number | boolean | null | readonly Field[];

const identifierOf = (schema: { readonly identifier: string }) =>
  schema.identifier;

const requireFields = (
  schema: Parameters<typeof Schema.decodeUnknownSync>[0] & {
    readonly identifier: string;
  },
  name: string,
  value: Record<string, Field>
) => {
  expect(identifierOf(schema)).toBe(name);
  const decode = Schema.decodeUnknownSync(schema);
  reject(() => decode({}));
  for (const key of Object.keys(value)) {
    const partial: Record<string, Field> = {};
    for (const [field, fieldValue] of Object.entries(value)) {
      if (field !== key && fieldValue !== undefined) {
        partial[field] = fieldValue;
      }
    }
    reject(() => decode(partial));
  }
  expect(decode(value)).toMatchObject(value);
};

const agentId = "agent_aaaaaaaaaaaaaaaaaaaaaaaa";
const roomId = "room_aaaaaaaaaaaaaaaaaaaaaaaa";

test("schemas keep their names and reject a missing field", () => {
  expect(Schema.decodeUnknownSync(MemberKind)("agent")).toBe("agent");
  expect(Schema.decodeUnknownSync(MemberKind)("human")).toBe("human");
  reject(() => Schema.decodeUnknownSync(MemberKind)(""));
  reject(() => Schema.decodeUnknownSync(MemberKind)("other"));
  requireFields(Actor, "Actor", {
    admin: false,
    agentId,
    displayName: "ada",
    kind: "agent",
  });
  requireFields(ReactionView, "ReactionView", { agentId, emoji: "👀" });
  requireFields(MessageView, "MessageView", {
    authorId: agentId,
    authorKind: "agent",
    authorName: "ada",
    body: "hello",
    createdAt: 1,
    editedAt: null,
    id: "msg_1",
    mentions: [],
    reactions: [],
    redacted: false,
    replyTo: null,
    seq: 1,
    threadRoot: null,
  });
  requireFields(MessagePage, "MessagePage", { messages: [], nextCursor: null });
  requireFields(ThreadSummary, "ThreadSummary", {
    lastSeq: 2,
    preview: "hello",
    replies: 1,
    rootSeq: 1,
  });
  const member = {
    agentId,
    displayName: "ada",
    joined: true,
    kind: "agent",
    lastReadSeq: 0,
    role: "member",
  };
  requireFields(MemberView, "MemberView", member);
  expect(
    Schema.decodeUnknownSync(MemberView)({ ...member, role: "lead" })
  ).toMatchObject({ role: "lead" });
  reject(() => Schema.decodeUnknownSync(MemberView)({ ...member, role: "" }));
  requireFields(UnreadView, "UnreadView", {
    lastReadSeq: 0,
    latestSeq: 1,
    roomId,
    unread: 1,
  });
  requireFields(RoomSummary, "RoomSummary", {
    leadId: agentId,
    name: "ops",
    roomId,
    topic: "delivery",
    youAreLead: false,
  });
  requireFields(IdentityView, "IdentityView", {
    admin: true,
    agentId,
    displayName: "ada",
    kind: "human",
  });
});

test("names and ids reject a broken anchor or length", () => {
  expect(Schema.decodeUnknownSync(DisplayName)("ada")).toBe("ada");
  expect(Schema.decodeUnknownSync(DisplayName)("a")).toBe("a");
  expect(Schema.decodeUnknownSync(DisplayName)("a_b")).toBe("a_b");
  reject(() => Schema.decodeUnknownSync(DisplayName)("1ada"));
  reject(() => Schema.decodeUnknownSync(DisplayName)("a!"));
  reject(() => Schema.decodeUnknownSync(DisplayName)(`a${"b".repeat(32)}`));
  expect(Schema.decodeUnknownSync(RoomName)("ops")).toBe("ops");
  expect(Schema.decodeUnknownSync(RoomName)("9")).toBe("9");
  expect(Schema.decodeUnknownSync(RoomName)("a b")).toBe("a b");
  reject(() => Schema.decodeUnknownSync(RoomName)("!ops"));
  reject(() => Schema.decodeUnknownSync(RoomName)("ops!"));
  expect(identifierOf(RoomId)).toBe("RoomId");
  expect(identifierOf(AgentId)).toBe("AgentId");
  expect(identifierOf(RequestId)).toBe("RequestId");
  expect(String(Schema.decodeUnknownSync(RoomId)(roomId))).toBe(roomId);
  reject(() => Schema.decodeUnknownSync(RoomId)(`x${roomId}`));
  reject(() => Schema.decodeUnknownSync(RoomId)(`${roomId}g`));
  expect(String(Schema.decodeUnknownSync(AgentId)(agentId))).toBe(agentId);
  reject(() => Schema.decodeUnknownSync(AgentId)(`x${agentId}`));
  reject(() => Schema.decodeUnknownSync(AgentId)(`${agentId}g`));
  const requestId = "req_aaaaaaaaaaaaaaaaaaaaaaaa";
  expect(String(Schema.decodeUnknownSync(RequestId)(requestId))).toBe(
    requestId
  );
  reject(() => Schema.decodeUnknownSync(RequestId)(`x${requestId}`));
  reject(() => Schema.decodeUnknownSync(RequestId)(`${requestId}g`));
});

test("minted ids are random hex with the effect span name", async () => {
  names.length = 0;
  const roomA = await traced(makeRoomId());
  const roomB = await traced(makeRoomId());
  const agent = await traced(makeAgentId());
  const request = await traced(makeRequestId());
  expect(roomA).toMatch(roomIdPattern);
  expect(roomA).not.toBe(roomB);
  expect(agent).toMatch(agentIdPattern);
  expect(request).toMatch(requestIdPattern);
  expect(names).toEqual([
    "Id.makeRoomId",
    "Id.makeRoomId",
    "Id.makeAgentId",
    "Id.makeRequestId",
  ]);
});

test("tokens hash, sign, and decode json under their span names", async () => {
  names.length = 0;
  const hashed = await traced(hashToken("token"));
  expect(hashed).toBe(createHash("sha256").update("token").digest("hex"));
  const secretA = await traced(makeSecret());
  const secretB = await traced(makeSecret());
  expect(secretA).toMatch(secretPattern);
  expect(secretA).not.toBe(secretB);
  const signed = await traced(signPayload("sek", "100", "body"));
  expect(signed).toBe(
    createHmac("sha256", "sek").update("100.body").digest("hex")
  );
  expect(await traced(decodeStoredJson('{"ok":true,"n":2}'))).toEqual({
    n: 2,
    ok: true,
  });
  reject(() => Effect.runSync(decodeStoredJson("not-json")));
  expect(names).toEqual([
    "Token.hash",
    "Token.secret",
    "Token.secret",
    "Token.sign",
  ]);
});

test("socket ids keep only the matching agent", () => {
  expect(
    socketIdsForAgent(
      [
        { agentId: "ada", id: "sock-1" },
        { agentId: "bob", id: "sock-2" },
        { agentId: "ada", id: "sock-3" },
      ],
      "ada"
    )
  ).toEqual(["sock-1", "sock-3"]);
  expect(socketIdsForAgent([{ agentId: "ada", id: "sock-1" }], "bob")).toEqual(
    []
  );
});

test("sql rows preserve every column and a bad statement fails", async () => {
  const raw = {
    admin: 1,
    agent_id: "agent",
    attempts: 2,
    author_id: "author",
    author_kind: "agent",
    author_name: "ada",
    body: "hello",
    created_at: 3,
    delivery_id: "dlv",
    display_name: "ada",
    edited_at: null,
    emoji: "👀",
    from_seq: 4,
    hop_count: 5,
    id: "msg",
    joined: 1,
    kind: "agent",
    last_delivered_at: 6,
    last_read_seq: 7,
    last_seq: 8,
    lead_id: "lead",
    mentions_json: "[]",
    message_ids_json: "[]",
    n: 9,
    name: "ops",
    not_before: 10,
    paused: 0,
    preview: "hello",
    redacted: 0,
    replies: 1,
    reply_to: null,
    role: "member",
    room_id: "room",
    root: 1,
    seq: 11,
    since_seq: 12,
    thread_root: null,
    to_seq: 13,
    token_hash: "hash",
    topic: "delivery",
    wake_seq: 14,
    webhook_secret: "sek",
    webhook_url: "http://127.0.0.1/hook",
  };
  expect(sqlRow(raw)).toEqual(raw);
  const rows = await openState("rows")(execRows("SELECT 7 AS n", [], "sql"));
  expect(rows[0]?.n).toBe(7);
  let failed = "";
  try {
    await openState("bad")(execRows("NOT SQL", [], "sql"));
  } catch (error) {
    failed = String(error);
  }
  expect(failed).toBe("sql");
});
