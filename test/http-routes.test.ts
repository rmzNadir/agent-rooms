import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { Chat } from "../src/app/chat.ts";
import { AgentId } from "../src/domain/ids.ts";
import { supportedProtocolVersions } from "../src/mcp/protocol.ts";
import {
  actorFor,
  adminAuth,
  chatRunner,
  httpClient,
  postAgent,
  requestId,
} from "./live-chat.ts";
import { startApi } from "./object-host.ts";

const Who = Schema.Struct({
  admin: Schema.Boolean,
  agentId: AgentId,
  displayName: Schema.String,
  kind: Schema.Literals(["agent", "human"]),
});
const Created = Schema.Struct({
  agent: Schema.Struct({ agentId: AgentId, displayName: Schema.String }),
  token: Schema.String,
});
const MessagePage = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({ body: Schema.String, seq: Schema.Number })
  ),
});
const WebhookResult = Schema.Struct({
  webhookUrl: Schema.NullOr(Schema.String),
});
const Initialized = Schema.Struct({
  result: Schema.Struct({
    protocolVersion: Schema.String,
    serverInfo: Schema.Struct({
      name: Schema.String,
      version: Schema.String,
    }),
  }),
});
const ToolList = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({
        description: Schema.String,
        inputSchema: Schema.Struct({
          additionalProperties: Schema.Boolean,
          required: Schema.Array(Schema.String),
          type: Schema.String,
        }),
        name: Schema.String,
      })
    ),
  }),
});
const ToolResult = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(
      Schema.Struct({ text: Schema.String, type: Schema.String })
    ),
    isError: Schema.Boolean,
  }),
});

const api = await startApi();
const { run } = chatRunner(api.host);
const { jsonBody, send } = httpClient(api.fetch);

test("http routes cover auth, viewer, room, and admin branches", async () => {
  const health = await send("/health");
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });
  const roomsPage = await send("/rooms");
  expect(roomsPage.status).toBe(200);
  expect(await roomsPage.text()).toContain('data-room=""');
  const denied = await send("/api/whoami");
  expect(denied.status).toBe(401);
  expect(await denied.json()).toMatchObject({
    code: "Unauthorized",
    message: "Send a bearer token for an agent, or the admin token.",
    retryable: false,
  });
  const basic = await send("/api/whoami", {
    headers: { authorization: "Basic abc" },
  });
  expect(basic.status).toBe(401);
  const named = await send("/api/whoami", { headers: adminAuth });
  const who = Schema.decodeUnknownSync(Who)(await named.json());
  expect(who).toMatchObject({
    admin: true,
    displayName: "human",
    kind: "human",
  });
  const adminActor = actorFor(who.agentId, "human", true, "human");
  const created = await postAgent(send, jsonBody, adminAuth, "ada", "agent");
  expect(created.status).toBe(200);
  const ada = Schema.decodeUnknownSync(Created)(await created.json());
  const room = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.createRoom({
        actor: adminActor,
        memberIds: [ada.agent.agentId],
        name: "http",
        requestId,
        topic: "routes",
      });
    })
  );
  const roomPage = await send(`/rooms/${room.roomId}`);
  expect(roomPage.status).toBe(200);
  expect(await roomPage.text()).toContain(`data-room="${room.roomId}"`);
  const adaAuth = {
    authorization: `Bearer ${ada.token}`,
    "content-type": "application/json",
  };
  const posted = await send(`/api/rooms/${room.roomId}/messages`, {
    body: jsonBody({ body: "hello @human", mentions: ["human"] }),
    headers: adaAuth,
    method: "POST",
  });
  expect(posted.status).toBe(200);
  const page = Schema.decodeUnknownSync(MessagePage)(await posted.json());
  expect(page.messages[0]?.body).toBe("hello @human");
  const listed = await send(`/api/rooms/${room.roomId}?since=0`, {
    headers: adminAuth,
  });
  expect(listed.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(MessagePage)(await listed.json()).messages[0]?.seq
  ).toBe(1);
  const later = await send(`/api/rooms/${room.roomId}/messages?since=1`, {
    headers: adminAuth,
  });
  expect(
    Schema.decodeUnknownSync(MessagePage)(await later.json()).messages
  ).toEqual([]);
  const badSince = await send(`/api/rooms/${room.roomId}/messages?since=abc`, {
    headers: adminAuth,
  });
  expect(badSince.status).toBe(400);
  expect(await badSince.json()).toMatchObject({
    code: "InvalidArgument",
    message: "since must be a non-negative integer. Correct it and retry.",
  });
  const threads = await send(`/api/rooms/${room.roomId}/threads`, {
    headers: adminAuth,
  });
  expect(threads.status).toBe(200);
  const badBody = await send(`/api/rooms/${room.roomId}/messages`, {
    body: jsonBody({ mentions: [] }),
    headers: adaAuth,
    method: "POST",
  });
  expect(badBody.status).toBe(400);
  expect(await badBody.json()).toMatchObject({
    code: "InvalidArgument",
    message:
      "body could not be read. Send the JSON body described in the README and retry.",
  });
  const untagged = await send(`/api/rooms/${room.roomId}/messages`, {
    body: jsonBody({ body: "ping", mentions: [] }),
    headers: adaAuth,
    method: "POST",
  });
  expect(untagged.status).toBe(400);
  expect(await untagged.json()).toMatchObject({ code: "MentionRequired" });
  const missingRoom = "room_0123456789abcdef01234567";
  const absent = await send(`/api/rooms/${missingRoom}/messages`, {
    headers: adminAuth,
  });
  expect(absent.status).toBe(404);
  expect(await absent.json()).toMatchObject({
    code: "RoomNotFound",
    message: `Room ${missingRoom} was not found. Check the id from list_rooms and try again.`,
  });
  const bob = Schema.decodeUnknownSync(Created)(
    await (
      await send("/admin/agents", {
        body: jsonBody({ displayName: "bob", kind: "human" }),
        headers: { ...adminAuth, "content-type": "application/json" },
        method: "POST",
      })
    ).json()
  );
  const outsider = await send(`/api/rooms/${room.roomId}/messages`, {
    headers: { authorization: `Bearer ${bob.token}` },
  });
  expect(outsider.status).toBe(403);
  expect(await outsider.json()).toMatchObject({ code: "NotMember" });
  const badCreate = await send("/admin/agents", {
    body: jsonBody({ kind: "agent" }),
    headers: { ...adminAuth, "content-type": "application/json" },
    method: "POST",
  });
  expect(badCreate.status).toBe(400);
  expect(await badCreate.json()).toMatchObject({
    message:
      "displayName could not be read. Send the JSON body described in the README and retry.",
  });
  const missingAgent = "agent_0123456789abcdef01234567";
  const rotated = await send(`/admin/agents/${missingAgent}/rotate`, {
    headers: adminAuth,
    method: "POST",
  });
  expect(rotated.status).toBe(404);
  expect(await rotated.json()).toMatchObject({
    code: "AgentNotFound",
    message: `Agent ${missingAgent} was not found. Check the id and retry.`,
  });
  const hooked = await send(`/admin/agents/${ada.agent.agentId}/webhook`, {
    body: jsonBody({ webhookUrl: "https://listener.example/hook" }),
    headers: adaAuth,
    method: "POST",
  });
  expect(hooked.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(WebhookResult)(await hooked.json())
  ).toMatchObject({
    webhookUrl: "https://listener.example/hook",
  });
  const crossHook = await send(`/admin/agents/${ada.agent.agentId}/webhook`, {
    body: jsonBody({ webhookUrl: null }),
    headers: { ...adminAuth, "content-type": "application/json" },
    method: "POST",
  });
  expect(crossHook.status).toBe(403);
  expect(await crossHook.json()).toMatchObject({
    code: "Forbidden",
    message: "That action needs the admin token. Retry with the admin bearer.",
  });
  const session = await send("/viewer/session", {
    body: "not-json",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  expect(session.status).toBe(400);
  expect(await session.json()).toMatchObject({
    message: "Send JSON { token } to start a viewer session.",
  });
  const opened = await send("/viewer/session", {
    body: jsonBody({ token: "admin-token" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  expect(opened.status).toBe(200);
  const cookie = opened.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("agent_rooms_token=");
  const fromCookie = await send("/api/whoami", {
    headers: { cookie: cookie.split(";")[0] ?? "" },
  });
  expect(fromCookie.status).toBe(200);
  expect(await fromCookie.json()).toMatchObject({ displayName: "human" });
  const initialize = await send("/mcp", {
    body: jsonBody({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "http-routes", version: "0" },
        protocolVersion: "2026-07-28",
      },
    }),
    headers: {
      ...adminAuth,
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
  });
  expect(initialize.status).toBe(200);
  const initialized = Schema.decodeUnknownSync(Initialized)(
    await initialize.json()
  );
  expect(initialized.result.serverInfo).toEqual({
    name: "agent-rooms",
    version: "0.1.0",
  });
  expect(
    (supportedProtocolVersions as readonly string[]).includes(
      initialized.result.protocolVersion
    )
  ).toBe(true);
  const rejected = await send("/mcp", {
    body: jsonBody({
      id: 2,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "http-routes", version: "0" },
        protocolVersion: "1999-01-01",
      },
    }),
    headers: {
      ...adminAuth,
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
  });
  const listedTools = await send("/mcp", {
    body: jsonBody({ id: 3, jsonrpc: "2.0", method: "tools/list" }),
    headers: {
      ...adminAuth,
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
  });
  expect(listedTools.status).toBe(200);
  const catalogue = Schema.decodeUnknownSync(ToolList)(
    await listedTools.json()
  );
  expect(catalogue.result.tools.map((tool) => tool.name)).toEqual([
    "list_rooms",
    "create_room",
    "invite",
    "join",
    "leave",
    "members",
    "post_message",
    "read_messages",
    "read_transcript",
    "list_threads",
    "search_messages",
    "wait_for_messages",
    "get_unread",
    "mark_read",
    "react",
    "edit_message",
    "redact_message",
    "whoami",
    "register_webhook",
  ]);
  const described = catalogue.result.tools.map((tool) => tool.description);
  expect(described).toContain("Rooms visible to the caller.");
  expect(described).toContain(
    "Create a room for one project. The first agent member becomes the lead coordinator."
  );
  expect(described).toContain(
    "Invite an agent. They are not a member until they call join."
  );
  expect(described).toContain("Join a room you were invited to.");
  expect(described).toContain(
    "Leave a room. The lead role moves to another member when one remains."
  );
  expect(described).toContain("List members of a room.");
  expect(described).toContain(
    "Post a message. Agents must @mention a target. An untagged human post wakes every agent member."
  );
  expect(described).toContain(
    "Messages strictly after since. A wake payload's since cursor belongs here."
  );
  expect(described).toContain("Paginated transcript as markdown or json.");
  expect(described).toContain("Thread roots in a room.");
  expect(described).toContain("Search message bodies in a room.");
  expect(described).toContain(
    "Long-poll for messages after since. The server caps the wait at 25 seconds."
  );
  expect(described).toContain("Unread count since the caller's read cursor.");
  expect(described).toContain("Advance the caller's read cursor to seq.");
  expect(described).toContain(
    "Toggle a reaction. Reactions do not wake anyone."
  );
  expect(described).toContain(
    "Replace your own message body. Edits do not wake anyone."
  );
  expect(described).toContain(
    "Redact your own message. An admin may redact any message."
  );
  expect(described).toContain("The authenticated identity.");
  expect(described).toContain(
    "Set the HTTPS URL that receives HMAC-signed wake payloads. Pass null to clear it."
  );
  for (const tool of catalogue.result.tools) {
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.additionalProperties).toBe(false);
  }
  const called = await send("/mcp", {
    body: jsonBody({
      id: 4,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: {}, name: "whoami" },
    }),
    headers: {
      ...adminAuth,
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
  });
  expect(called.status).toBe(200);
  const whoami = Schema.decodeUnknownSync(ToolResult)(await called.json());
  expect(whoami.result.isError).toBe(false);
  expect(whoami.result.content[0]?.text).toContain('"displayName"');
  expect(rejected.status).toBe(400);
  expect(await rejected.text()).toContain("1999-01-01");
  const missing = await send("/nope", { method: "POST" });
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({
    code: "NotFound",
    message: "That path is not served. Use /mcp, /health, or the viewer.",
    retryable: false,
  });
});
