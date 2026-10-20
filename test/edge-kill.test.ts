import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { bearerToken, matchedId, rotatePattern } from "../src/api/access.ts";
import {
  absoluteUrl,
  fallbackAdminName,
  sessionCookie,
} from "../src/api/session.ts";
import { Chat } from "../src/app/chat.ts";
import { badDisplay, badName, duplicateName } from "../src/app/chat-support.ts";
import { rememberedSecret } from "../src/app/directory-chat.ts";
import { queryOf } from "../src/app/limits.ts";
import { mapRejection, shownSeq, takenName } from "../src/app/map-error.ts";
import { readCursor, tailSeq, threadList } from "../src/app/pages.ts";
import {
  MemberList,
  ThreadList,
  WebhookRegistration,
} from "../src/app/records.ts";
import { internalRequestId } from "../src/domain/ids.ts";
import { jsonText } from "../src/mcp/call-tool.ts";
import {
  acceptHeader,
  blankBody,
  eventStream,
  finishSse,
  handlerInit,
  jsonHeaders,
  mcpAuth,
  mcpHandlerOptions,
  mediaType,
  responseType,
  serveMcp,
  singleSseData,
  tooLargeBody,
  toolArgs,
} from "../src/mcp/handler.ts";
import {
  hashesMatch,
  roomOnly,
  sameCredential,
} from "../src/runtime/legacy-apply.ts";
import {
  cellNumber,
  cellText,
  optionalNumber,
} from "../src/runtime/legacy-store.ts";
import { fulfill } from "./effect-run.ts";
import {
  actorFor,
  chatRunner,
  createPerson,
  requestId,
  resolveAdmin,
} from "./live-chat.ts";
import { leadId, message } from "./model-fixture.ts";
import { startHost } from "./object-host.ts";

const request = internalRequestId;
const barePattern = /^x$/;

test("literal helpers keep the exact header, auth, and cell values", () => {
  expect(jsonHeaders()).toEqual({ "content-type": "application/json" });
  expect(acceptHeader(null)).toBe("");
  expect(acceptHeader("application/json")).toBe("application/json");
  expect(responseType(null)).toBe("application/json");
  expect(responseType("text/plain")).toBe("text/plain");
  expect(mcpHandlerOptions()).toEqual({ legacy: "stateless" });
  expect(mcpAuth("agent_bbbbbbbbbbbbbbbbbbbbbbbb")).toEqual({
    clientId: "agent_bbbbbbbbbbbbbbbbbbbbbbbb",
    extra: { agentId: "agent_bbbbbbbbbbbbbbbbbbbbbbbb" },
    scopes: [],
    token: "bearer",
  });
  expect(cellText(undefined)).toBe("");
  expect(cellText(null)).toBe("");
  expect(cellText("ada")).toBe("ada");
  expect(cellNumber(undefined)).toBe(0);
  expect(cellNumber(null)).toBe(0);
  expect(cellNumber("4")).toBe(4);
  expect(optionalNumber(undefined)).toBeNull();
  expect(optionalNumber(null)).toBeNull();
  expect(optionalNumber("")).toBeNull();
  expect(optionalNumber("4")).toBe(4);
  expect(shownSeq({})).toBe(0);
  expect(shownSeq({ seq: 5 })).toBe(5);
  expect(takenName(undefined)).toBe("");
  expect(takenName("ops")).toBe("ops");
  expect(hashesMatch([], [])).toBe(true);
  expect(
    hashesMatch(
      [{ agentId: "a", tokenHash: "one" }],
      [{ agentId: "a", tokenHash: "two" }]
    )
  ).toBe(false);
  expect(
    hashesMatch(
      [{ agentId: "a", tokenHash: "one" }],
      [{ agentId: "a", tokenHash: "one" }]
    )
  ).toBe(true);
  expect(
    hashesMatch(
      [{ agentId: "a", tokenHash: "one" }],
      [{ agentId: "b", tokenHash: "one" }]
    )
  ).toBe(false);
  expect(
    sameCredential(
      { agentId: "a", tokenHash: "one" },
      { agentId: "b", tokenHash: "one" }
    )
  ).toBe(false);
  expect(
    sameCredential(
      { agentId: "a", tokenHash: "one" },
      { agentId: "a", tokenHash: "two" }
    )
  ).toBe(false);
  expect(
    sameCredential(
      { agentId: "a", tokenHash: "one" },
      { agentId: "a", tokenHash: "one" }
    )
  ).toBe(true);
  expect(WebhookRegistration.identifier).toBe("WebhookRegistration");
  expect(MemberList.identifier).toBe("MemberList");
  expect(ThreadList.identifier).toBe("ThreadList");
  expect(() => Schema.decodeUnknownSync(WebhookRegistration)({})).toThrow();
  expect(() => Schema.decodeUnknownSync(MemberList)({})).toThrow();
  expect(() => Schema.decodeUnknownSync(ThreadList)({})).toThrow();
  expect(badDisplay(request).details).toEqual({
    constraint: "must match [A-Za-z][A-Za-z0-9_-]{0,31}",
    field: "displayName",
  });
  expect(badDisplay(request).message).toBe(
    "Display name must be one mention token, such as ada or coordinator."
  );
  expect(badName(request).message).toBe(
    "name must be a short room name. Correct it and retry."
  );
  expect(badName(request).details).toEqual({
    constraint: "see the README for the accepted pattern",
    field: "name",
  });
  expect(duplicateName(request, "ada").message).toBe(
    "An agent named ada already exists. Choose a different display name."
  );
  expect(duplicateName(request, "ada").details).toEqual({
    constraint: "must be unique",
    field: "displayName",
  });
  const tied = threadList(
    [message(1, leadId, "alpha"), message(1, leadId, "beta")],
    10
  );
  expect(tied[0]?.preview).toBe("beta");
  const ordered = threadList(
    [message(1, leadId, "old"), message(4, leadId, "new")],
    10
  );
  expect(ordered.map((item) => item.preview)).toEqual(["new", "old"]);
});

test("a rejected protocol response keeps the json content type", async () => {
  const actor = actorFor(
    "agent_bbbbbbbbbbbbbbbbbbbbbbbb" as never,
    "ada",
    false,
    "agent"
  );
  const response = await serveMcp(
    new Request("http://localhost/mcp", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "1999-01-01" },
      }),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      method: "POST",
    }),
    actor,
    undefined as never
  );
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(response.status).toBe(400);
});

test("mapped seqs and an empty search keep their text", async () => {
  const author = mapRejection(
    { _tag: "NotAuthor" } as never,
    {
      operation: "edit",
      requestId: request,
      roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaa",
      seq: 5,
      verb: "edit",
    } as never
  );
  expect(author.message).toBe(
    "Message 5 belongs to someone else. You can edit only your own messages."
  );
  expect(author.details).toEqual({
    roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaa",
    seq: 5,
  });
  const empty = await fulfill(
    (
      queryOf(request, " ") as Effect.Effect<
        string,
        { readonly message: string; readonly operation: string }
      >
    ).pipe(
      Effect.match({
        onFailure: (error) => error,
        onSuccess: () => ({ message: "", operation: "" }),
      })
    )
  );
  expect(empty.message).toBe("query must not be empty. Correct it and retry.");
  expect(empty.operation).toBe("search_messages");
});

test("a room with no agent lead is refused and a wait honors the clock", async () => {
  const host = await startHost();
  const { failure, run } = chatRunner(host);
  const admin = await resolveAdmin(run);
  const missing = await failure(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.createRoom({
        actor: admin,
        memberIds: [],
        name: "solo",
        requestId,
        topic: "",
      });
    })
  );
  expect(missing).toMatchObject({
    message:
      "A room needs at least one agent member to lead it. Add an agent and retry.",
    operation: "create_room",
  });
  const created = await createPerson(run, admin, "ada", "agent");
  const memberIds = [created.actor.agentId];
  const room = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.createRoom({
        actor: admin,
        memberIds,
        name: "ops",
        requestId,
        topic: "ship",
      });
    })
  );
  const listed = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.listRooms(admin, requestId);
    })
  );
  expect(listed[0]?.youAreLead).toBe(false);
  const adaListed = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.listRooms(created.actor, requestId);
    })
  );
  expect(adaListed[0]?.youAreLead).toBe(true);
  const started = Date.now();
  const quiet = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.waitForMessages(
        created.actor,
        requestId,
        room.roomId,
        0,
        10,
        500
      );
    })
  );
  expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  expect(quiet.messages).toEqual([]);
  await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.postMessage({
        actor: admin,
        body: "hello",
        mentions: [],
        replyTo: null,
        requestId,
        roomId: room.roomId,
        threadRoot: null,
      });
    })
  );
  const fast = Date.now();
  const woke = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.waitForMessages(
        created.actor,
        requestId,
        room.roomId,
        0,
        10,
        2000
      );
    })
  );
  expect(Date.now() - fast).toBeLessThan(300);
  expect(woke.messages[0]?.body).toBe("hello");
});

test("extracted branches keep ids, cursors, and sse payloads", async () => {
  const room = "room_aaaaaaaaaaaaaaaaaaaaaaaa";
  expect(blankBody()).toBe("");
  expect(fallbackAdminName).toBe("human");
  expect(absoluteUrl("http://door.example/rooms").href).toBe(
    "http://door.example/rooms"
  );
  expect(absoluteUrl("https://door.example/rooms").href).toBe(
    "https://door.example/rooms"
  );
  expect(absoluteUrl("/rooms").href).toBe("http://localhost/rooms");
  expect(sessionCookie(true)).toEqual({
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: true,
  });
  expect(bearerToken({ toString: () => "Bearer secret" })).toBeUndefined();
  expect(bearerToken("Bearer secret")).toBe("secret");
  expect(bearerToken("nope")).toBeUndefined();
  const rotate = rotatePattern.exec(
    "/admin/agents/agent_bbbbbbbbbbbbbbbbbbbbbbbb/rotate"
  );
  expect(rotate).not.toBeNull();
  if (rotate !== null) {
    expect(matchedId(rotate)).toBe("agent_bbbbbbbbbbbbbbbbbbbbbbbb");
  }
  expect(matchedId(barePattern.exec("x") as RegExpExecArray)).toBe("");
  expect(readCursor(undefined, 0)).toBe(0);
  expect(readCursor({ lastReadSeq: 4 }, 0)).toBe(4);
  expect(tailSeq([])).toBe(0);
  expect(tailSeq([{ seq: 1 }])).toBe(1);
  expect(rememberedSecret(undefined)).toBe("");
  expect(rememberedSecret({ secret: "abc" })).toBe("abc");
  expect(mediaType("text/event-stream; charset=utf-8")).toBe(
    "text/event-stream"
  );
  expect(mediaType(" text/event-stream ; charset=utf-8")).toBe(
    "text/event-stream"
  );
  expect(eventStream(" text/event-stream ; charset=utf-8")).toBe(true);
  expect(eventStream(null)).toBe(false);
  expect(eventStream("text/event-stream")).toBe(true);
  expect(eventStream("application/json")).toBe(false);
  expect(eventStream("text/event-stream; charset=utf-8")).toBe(true);
  const payload = 'data: {"ok":true}';
  expect(singleSseData(`${payload}\n`)).toBe('{"ok":true}');
  expect(singleSseData(`${payload}\ndata:\n`)).toBe('{"ok":true}');
  expect(singleSseData('data: {"a":1}\ndata: {"b":2}\n')).toBeUndefined();
  expect(singleSseData("data: nope\n")).toBeUndefined();
  expect(singleSseData(`event: x\n${payload}\n`)).toBe('{"ok":true}');
  const headers = new Headers({ "x-test": "1" });
  const kept = finishSse("data: nope\n", 207, headers);
  expect(kept.status).toBe(207);
  expect(kept.headers.get("x-test")).toBe("1");
  expect(await kept.text()).toBe("data: nope\n");
  const parsed = finishSse(`${payload}\n`, 200, headers);
  expect(parsed.headers.get("content-type")).toBe("application/json");
  expect(await parsed.text()).toBe('{"ok":true}');
  expect(toolArgs(null)).toEqual({ arguments: "rejected" });
  expect(toolArgs(1)).toEqual({ arguments: "rejected" });
  expect(toolArgs({ room })).toEqual({ room });
  expect(handlerInit("agent_bbbbbbbbbbbbbbbbbbbbbbbb")).toEqual({
    authInfo: mcpAuth("agent_bbbbbbbbbbbbbbbbbbbbbbbb"),
  });
  expect(tooLargeBody()).toBe(
    '{"error":{"code":-32013,"message":"Payload Too Large"},"id":null,"jsonrpc":"2.0"}'
  );
  const snap = {
    hopCount: 0,
    leadId: "agent_bbbbbbbbbbbbbbbbbbbbbbbb",
    members: [],
    messages: [],
    name: "n",
    paused: false,
    roomId: room,
    topic: "t",
  };
  expect(roomOnly(snap).agents).toEqual([]);
  expect(roomOnly(snap).rooms).toEqual([snap]);
  expect(await fulfill(jsonText(1n))).toBe(
    '{"code":"Unavailable","message":"The response could not be encoded. Retry the same request.","details":{},"requestId":"req_000000000000000000000001","retryable":true}'
  );
});
