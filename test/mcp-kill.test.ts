import { expect, test } from "bun:test";
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from "@modelcontextprotocol/server";
import { Cause, Effect, Schema } from "effect";
import { HttpClientRequest, HttpServerRequest } from "effect/http";
import type { Json } from "effect/Schema";
import { chatLayer } from "../src/app/chat.ts";
import { parseJson } from "../src/boundary/external.ts";
import type { Actor } from "../src/domain/actor.ts";
import { callTool } from "../src/mcp/call-tool.ts";
import { handleMcp } from "../src/mcp/handler.ts";
import { fulfill } from "./effect-run.ts";
import {
  chatRunner,
  createPerson,
  requestId,
  resolveAdmin,
} from "./live-chat.ts";
import { startApi } from "./object-host.ts";

const api = await startApi();
const { run } = chatRunner(api.host);
const admin = await resolveAdmin(run);
const ada = await createPerson(run, admin, "ada", "agent");
const bob = await createPerson(run, admin, "bob", "human");
const maxBody = DEFAULT_MAX_REQUEST_BODY_SIZE;

const schemaMessage = (field: string) =>
  `${field} does not match the tool schema. Correct it and retry.`;

const initialize = (version: string, name = "t") =>
  JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name, version: "0" },
      protocolVersion: version,
    },
  });

const framed = (bytes: number) => {
  const shell = initialize("1999-01-01", "");
  return initialize("1999-01-01", "n".repeat(bytes - shell.length));
};

const mcp = (body: string | null, headers: Record<string, string>) =>
  api.fetch(
    new Request("http://localhost/mcp", {
      body,
      headers: {
        authorization: "Bearer admin-token",
        "content-type": "application/json",
        ...headers,
      },
      method: "POST",
    })
  );

const mcpStream = (body: ReadableStream<Uint8Array>) =>
  api.fetch(
    new Request("http://localhost/mcp", {
      body,
      duplex: "half",
      headers: {
        accept: "application/json",
        authorization: "Bearer admin-token",
        "content-type": "application/json",
      },
      method: "POST",
    })
  );

const streamOf = (chunks: readonly Uint8Array[]) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

const chunkStream = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const mid = Math.floor(bytes.length / 2);
  return streamOf([
    new Uint8Array(bytes.subarray(0, mid)),
    new Uint8Array(bytes.subarray(mid)),
  ]);
};

const paddedStream = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const pad = new Uint8Array(bytes.length + 2);
  pad[0] = 1;
  pad.set(bytes, 1);
  pad[pad.length - 1] = 1;
  return streamOf([pad.subarray(1, 1 + bytes.length)]);
};

const textStream = (text: string) => streamOf([new TextEncoder().encode(text)]);

const toolFailure = async (actor: Actor, name: string, args: object) => {
  const exit = await fulfill(
    Effect.scoped(Effect.exit(callTool(actor, name, args, requestId))).pipe(
      Effect.provide(chatLayer),
      Effect.provide(api.host)
    )
  );
  if (exit._tag === "Success") {
    throw new Error(`succeeded ${name} ${JSON.stringify(args)}`);
  }
  return Cause.squash(exit.cause);
};

const toolValue = async (actor: Actor, name: string, args: object) => {
  const body = await run(
    Effect.gen(function* () {
      return yield* callTool(actor, name, args, requestId);
    })
  );
  const text = body.content[0]?.text ?? "";
  if (body.isError) {
    throw new Error(text);
  }
  return parseJson(text);
};

const roomIdOf = (value: Json) =>
  Schema.decodeUnknownSync(Schema.Struct({ roomId: Schema.String }))(value)
    .roomId;

const seedRoom = roomIdOf(
  await toolValue(ada.actor, "create_room", {
    members: [admin.agentId],
    name: "seed",
    topic: "seed",
  })
);

test("mcp http keeps protocol, size, and stream checks", async () => {
  const accepted = await mcp(initialize("2025-06-18"), {
    accept: "application/json",
  });
  const acceptedText = await accepted.text();
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("content-type")).toBe("application/json");
  expect(acceptedText.startsWith("{")).toBe(true);
  const initialized = parseJson(acceptedText);
  expect(initialized).toMatchObject({
    result: {
      capabilities: { tools: { listChanged: false } },
      protocolVersion: "2025-06-18",
      serverInfo: { name: "agent-rooms", version: "0.1.0" },
    },
  });
  const streamed = await mcp(initialize("2025-06-18"), {
    accept: "application/json, text/event-stream",
  });
  const streamedText = await streamed.text();
  expect(streamed.status).toBe(200);
  expect(streamed.headers.get("content-type")).toBe("text/event-stream");
  expect(streamedText.startsWith("event: message\ndata: {")).toBe(true);
  const onlyStream = await mcp(initialize("2025-06-18"), {
    accept: "text/event-stream",
  });
  expect(onlyStream.status).toBe(406);
  expect(await onlyStream.text()).toContain(
    "Client must accept both application/json and text/event-stream"
  );
  const rejected = await mcp(initialize("1999-01-01"), {
    accept: "application/json",
  });
  const rejectedText = await rejected.text();
  expect(rejected.status).toBe(400);
  expect(rejected.headers.get("content-type")).toBe("application/json");
  expect(parseJson(rejectedText)).toMatchObject({
    error: {
      code: -32_022,
      data: {
        requested: "1999-01-01",
        supported: ["2026-07-28", "2025-11-25", "2025-06-18"],
      },
      message: "Unsupported protocol version",
    },
    id: 1,
    jsonrpc: "2.0",
  });
  const empty = await mcp(null, { accept: "application/json" });
  expect(empty.status).toBe(400);
  expect(await empty.text()).toContain("Parse error: Invalid JSON");
  const declared = await mcp(initialize("1999-01-01"), {
    accept: "application/json",
    "content-length": String(maxBody + 1),
  });
  expect(declared.status).toBe(413);
  expect(await declared.text()).toContain('{"error":{"code":-32013');
  const exactHeader = await mcp(initialize("1999-01-01"), {
    accept: "application/json",
    "content-length": String(maxBody),
  });
  expect(exactHeader.status).toBe(400);
  expect(await exactHeader.text()).toContain("Unsupported protocol version");
  const over = await mcpStream(textStream(framed(maxBody + 1)));
  expect(over.status).toBe(413);
  const exact = await mcpStream(textStream(framed(maxBody)));
  expect(exact.status).toBe(400);
  expect(await exact.text()).toContain("Unsupported protocol version");
  const split = await mcpStream(chunkStream(initialize("1999-01-01")));
  expect(split.status).toBe(400);
  expect(await split.text()).toContain("Unsupported protocol version");
  const padded = await mcpStream(paddedStream(initialize("1999-01-01")));
  expect(padded.status).toBe(400);
  expect(await padded.text()).toContain("Unsupported protocol version");
  const called = await mcp(
    JSON.stringify({
      id: 4,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          members: [ada.actor.agentId],
          name: "handler-room",
          topic: "from-handler",
        },
        name: "create_room",
      },
    }),
    { accept: "application/json", "mcp-protocol-version": "2025-06-18" }
  );
  const callBody = parseJson(await called.text());
  expect(callBody).toMatchObject({
    result: { isError: false },
  });
  expect(JSON.stringify(callBody)).toContain("from-handler");
});

test("a client request cannot be served as mcp", async () => {
  const died = await fulfill(
    Effect.flip(
      Effect.sandbox(
        handleMcp(admin).pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromClientRequest(
              HttpClientRequest.post("http://localhost/mcp")
            )
          ),
          Effect.provide(api.host)
        )
      )
    )
  );
  expect(Cause.pretty(died)).toContain(
    "The worker request has no web Request."
  );
});

test("tool arguments keep field names", async () => {
  expect(await toolFailure(admin, "members", {})).toMatchObject({
    message: schemaMessage("room"),
    operation: "tools/call",
  });
  expect(
    await toolFailure(admin, "post_message", { room: "room" })
  ).toMatchObject({
    message: schemaMessage("body"),
  });
  expect(
    await toolFailure(admin, "post_message", { body: 1, room: "room" })
  ).toMatchObject({ message: schemaMessage("body") });
  expect(
    await toolFailure(admin, "post_message", {
      body: "hi",
      mentions: 1,
      room: "room",
    })
  ).toMatchObject({ message: schemaMessage("mentions") });
  expect(
    await toolFailure(admin, "post_message", {
      body: "hi",
      reply_to: "no",
      room: "room",
    })
  ).toMatchObject({ message: schemaMessage("reply_to") });
  expect(
    await toolFailure(admin, "post_message", {
      body: "hi",
      room: seedRoom,
      thread_root: "no",
    })
  ).toMatchObject({ message: schemaMessage("thread_root") });
  expect(
    await toolFailure(admin, "read_messages", { room: seedRoom, thread: "no" })
  ).toMatchObject({ message: schemaMessage("thread") });
  expect(
    await toolFailure(admin, "read_messages", { limit: "no", room: "room" })
  ).toMatchObject({ message: schemaMessage("limit") });
  expect(
    await toolFailure(admin, "read_messages", { room: seedRoom, since: "no" })
  ).toMatchObject({ message: schemaMessage("since") });
  expect(
    await toolFailure(admin, "read_transcript", { format: "xml", room: "room" })
  ).toMatchObject({ message: schemaMessage("format") });
  expect(
    await toolFailure(admin, "wait_for_messages", {
      room: "room",
      timeout_ms: "no",
    })
  ).toMatchObject({ message: schemaMessage("timeout_ms") });
  expect(await toolFailure(admin, "create_room", {})).toMatchObject({
    message: schemaMessage("name"),
  });
  expect(await toolFailure(admin, "create_room", { name: 1 })).toMatchObject({
    message: schemaMessage("name"),
  });
  expect(
    await toolFailure(admin, "create_room", { name: "alpha", topic: 1 })
  ).toMatchObject({ message: schemaMessage("topic") });
  expect(
    await toolFailure(admin, "create_room", { members: "no", name: "alpha" })
  ).toMatchObject({ message: schemaMessage("members") });
  expect(
    await toolFailure(admin, "edit_message", { room: seedRoom })
  ).toMatchObject({
    message: schemaMessage("seq"),
  });
  expect(
    await toolFailure(admin, "edit_message", {
      body: 1,
      room: seedRoom,
      seq: 1,
    })
  ).toMatchObject({ message: schemaMessage("body") });
  expect(
    await toolFailure(admin, "invite", { agent_id: "nope", room: seedRoom })
  ).toMatchObject({ message: schemaMessage("agent_id") });
  expect(
    await toolFailure(admin, "mark_read", { room: seedRoom, seq: "no" })
  ).toMatchObject({
    message: schemaMessage("seq"),
  });
  expect(
    await toolFailure(admin, "react", { room: seedRoom, seq: "no" })
  ).toMatchObject({
    message: schemaMessage("seq"),
  });
  expect(
    await toolFailure(admin, "react", { emoji: 1, room: seedRoom, seq: 1 })
  ).toMatchObject({ message: schemaMessage("emoji") });
  expect(
    await toolFailure(admin, "redact_message", { room: seedRoom, seq: "no" })
  ).toMatchObject({ message: schemaMessage("seq") });
  expect(
    await toolFailure(admin, "register_webhook", { webhook_url: 1 })
  ).toMatchObject({ message: schemaMessage("webhook_url") });
  expect(
    await toolFailure(admin, "search_messages", { query: 1, room: seedRoom })
  ).toMatchObject({ message: schemaMessage("query") });
  const unknown = await run(
    Effect.gen(function* () {
      return yield* callTool(admin, "not_a_tool", {}, requestId);
    })
  );
  expect(unknown.content[0]?.text).toContain(
    "name is not a tool this server provides. Correct it and retry."
  );
  expect(await toolFailure(admin, "whoami", [])).toMatchObject({
    message: schemaMessage("arguments"),
  });
});

test("mcp tools apply decoded arguments", async () => {
  const adaRoom = await toolValue(ada.actor, "create_room", {
    name: "ada-room",
  });
  expect(adaRoom).toMatchObject({ name: "ada-room", topic: "" });
  const shared = await toolValue(ada.actor, "create_room", {
    members: [admin.agentId],
    name: "shared",
    topic: "kept",
  });
  expect(shared).toMatchObject({ topic: "kept" });
  const roomId = roomIdOf(shared);
  const invited = await toolValue(ada.actor, "invite", {
    agent_id: bob.actor.agentId,
    room: roomId,
  });
  expect(invited).toMatchObject({ joined: false });
  const joined = await toolValue(bob.actor, "join", { room: roomId });
  expect(joined).toMatchObject({ joined: true });
  const posted = await toolValue(admin, "post_message", {
    body: "hello",
    room: roomId,
  });
  expect(posted).toMatchObject({ messages: [{ mentions: ["all"] }] });
  const mentioned = await toolValue(ada.actor, "post_message", {
    body: "ping",
    mentions: ["human"],
    room: roomId,
  });
  expect(mentioned).toMatchObject({ messages: [{ mentions: ["human"] }] });
  const limited = await toolValue(admin, "read_messages", {
    limit: 1,
    room: roomId,
    since: 0,
  });
  expect(limited).toMatchObject({ messages: [{ seq: 1 }] });
  const later = await toolValue(ada.actor, "read_messages", {
    room: roomId,
    since: 1,
  });
  expect(later).toMatchObject({ messages: [{ seq: 2 }] });
  const reply = await toolValue(admin, "post_message", {
    body: "reply",
    reply_to: 1,
    room: roomId,
    thread_root: 1,
  });
  expect(reply).toMatchObject({
    messages: [{ replyTo: 1, threadRoot: 1 }],
  });
  const threaded = await toolValue(admin, "read_messages", {
    room: roomId,
    thread: 1,
  });
  expect(threaded).toMatchObject({ messages: [{ seq: 1 }, { seq: 3 }] });
  const markdown = await toolValue(admin, "read_transcript", { room: roomId });
  expect(markdown).toMatchObject({ format: "markdown" });
  const json = await toolValue(admin, "read_transcript", {
    format: "json",
    room: roomId,
  });
  expect(json).toMatchObject({ format: "json" });
  const threads = await toolValue(admin, "list_threads", {
    limit: 10,
    room: roomId,
  });
  expect(threads).toMatchObject({
    threads: [{ rootSeq: 1 }, { rootSeq: 2 }],
  });
  const found = await toolValue(admin, "search_messages", {
    query: "ping",
    room: roomId,
  });
  expect(found).toMatchObject({ messages: [{ body: "ping" }] });
  const waited = await toolValue(admin, "wait_for_messages", {
    room: roomId,
    timeout_ms: 0,
  });
  expect(JSON.stringify(waited)).toContain('"seq":1');
  const unread = await toolValue(bob.actor, "get_unread", { room: roomId });
  expect(unread).toMatchObject({ unread: 3 });
  const marked = await toolValue(bob.actor, "mark_read", {
    room: roomId,
    seq: 1,
  });
  expect(marked).toMatchObject({ lastReadSeq: 1 });
  const reacted = await toolValue(admin, "react", {
    emoji: "ok",
    room: roomId,
    seq: 1,
  });
  expect(reacted).toMatchObject({
    reactions: [{ agentId: admin.agentId, emoji: "ok" }],
  });
  const edited = await toolValue(admin, "edit_message", {
    body: "hello edited",
    room: roomId,
    seq: 1,
  });
  expect(edited).toMatchObject({ body: "hello edited" });
  const redacted = await toolValue(admin, "redact_message", {
    room: roomId,
    seq: 1,
  });
  expect(redacted).toMatchObject({ redacted: true });
  const hook = await toolValue(ada.actor, "register_webhook", {
    webhook_url: "https://hooks.example/wake",
  });
  expect(hook).toMatchObject({ webhookUrl: "https://hooks.example/wake" });
  const left = await toolValue(bob.actor, "leave", { room: roomId });
  expect(left).toMatchObject({ ok: true });
  const members = await toolValue(admin, "members", { room: roomId });
  expect(JSON.stringify(members)).toContain('"displayName":"ada"');
  expect(JSON.stringify(members)).toContain('"displayName":"human"');
  const rooms = await toolValue(ada.actor, "list_rooms", {});
  expect(JSON.stringify(rooms)).toContain('"name":"ada-room"');
  expect(JSON.stringify(rooms)).toContain('"name":"shared"');
  const who = await toolValue(admin, "whoami", {});
  expect(who).toMatchObject({
    admin: true,
    displayName: "human",
    kind: "human",
  });
});
