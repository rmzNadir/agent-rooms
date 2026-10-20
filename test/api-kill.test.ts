import { expect, test } from "bun:test";
import { ConfigProvider, Effect, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import {
  decodeAgent,
  decodeRoom,
  forbidden,
  readJson,
  sinceParam,
  skipped,
  WebhookBody,
} from "../src/api/access.ts";
import { loadActor } from "../src/api/session.ts";
import { Chat, chatLayer } from "../src/app/chat.ts";
import { AgentId, internalRequestId } from "../src/domain/ids.ts";
import { fulfill } from "./effect-run.ts";
import {
  actorFor,
  adminAuth,
  chatRunner,
  httpClient,
  postAgent,
  requestId,
} from "./live-chat.ts";
import { startApi } from "./object-host.ts";

const api = await startApi();
const { jsonBody, send } = httpClient(api.fetch);
const { run } = chatRunner(api.host);
const roomToken = "room_0123456789abcdef01234567";
const agentToken = "agent_0123456789abcdef01234567";
const headerOf = (response: Response, name: string) =>
  response.headers.get(name) ?? "";

const envOf = (entries: ReadonlyArray<readonly [string, string]>) => {
  const env: { [key: string]: string } = {};
  for (const [key, value] of entries) {
    env[key] = value;
  }
  return ConfigProvider.fromEnv({ env });
};

const actorNamed = (
  host: Awaited<ReturnType<typeof startApi>>["host"],
  entries: ReadonlyArray<readonly [string, string]>
) =>
  fulfill(
    Effect.scoped(loadActor("admin-token")).pipe(
      Effect.provide(chatLayer),
      Effect.provide(host),
      Effect.provideService(ConfigProvider.ConfigProvider, envOf(entries))
    )
  );

const failedJson = (body: string, field: string) =>
  fulfill(
    Effect.flip(
      readJson(WebhookBody, internalRequestId, field).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://localhost/hook", {
              body,
              headers: { "content-type": "application/json" },
              method: "POST",
            })
          )
        )
      )
    )
  );

test("admin name and token config stay exact", async () => {
  const named = await startApi();
  const hostActor = await actorNamed(named.host, [
    ["AGENT_ROOMS_ADMIN_TOKEN", "admin-token"],
    ["AGENT_ROOMS_ADMIN_NAME", "host"],
  ]);
  expect(hostActor.displayName).toBe("host");
  expect(hostActor.admin).toBe(true);
  const fallback = await startApi();
  const defaultActor = await actorNamed(fallback.host, [
    ["AGENT_ROOMS_ADMIN_TOKEN", "admin-token"],
  ]);
  expect(defaultActor.displayName).toBe("human");
  const bare = await startApi();
  const down = await fulfill(
    Effect.flip(
      Effect.scoped(loadActor("admin-token")).pipe(
        Effect.provide(chatLayer),
        Effect.provide(bare.host),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: {} })
        )
      )
    )
  );
  expect(down.code).toBe("Unavailable");
  expect(down.operation).toBe("authenticate");
  expect(down.retryable).toBe(true);
  expect(down.message).toBe(
    "The server could not read its admin token. Set AGENT_ROOMS_ADMIN_TOKEN and retry."
  );
});

test("auth parsing, ids, and json bodies keep their errors", async () => {
  const denied = forbidden(internalRequestId);
  expect(denied.code).toBe("Forbidden");
  expect(denied.operation).toBe("admin");
  expect(denied.retryable).toBe(false);
  expect(denied.message).toBe(
    "That action needs the admin token. Retry with the admin bearer."
  );
  const room = await fulfill(Effect.flip(decodeRoom("room-nope", requestId)));
  expect(room.code).toBe("InvalidArgument");
  expect(room.operation).toBe("room.read");
  expect(room.retryable).toBe(false);
  expect(room.details).toEqual({ constraint: "room_[24 hex]", field: "room" });
  expect(room.message).toBe(
    "room must be a room id. Check the path and retry."
  );
  const agent = await fulfill(
    Effect.flip(decodeAgent("agent-nope", requestId))
  );
  expect(agent.code).toBe("InvalidArgument");
  expect(agent.operation).toBe("admin");
  expect(agent.retryable).toBe(false);
  expect(agent.details).toEqual({
    constraint: "agent_[24 hex]",
    field: "agentId",
  });
  expect(agent.message).toBe(
    "agent id must look like agent_ plus 24 hex characters. Check it and retry."
  );
  const broken = await failedJson("not-json", "webhookUrl");
  expect(broken.code).toBe("InvalidArgument");
  expect(broken.operation).toBe("http.body");
  expect(broken.retryable).toBe(false);
  expect(broken.details).toEqual({ constraint: "json", field: "webhookUrl" });
  expect(broken.message).toBe(
    "webhookUrl could not be read. Send the JSON body described in the README and retry."
  );
  const missing = await failedJson("{}", "body");
  expect(missing.details).toEqual({ constraint: "json", field: "body" });
  expect(missing.message).toBe(
    "body could not be read. Send the JSON body described in the README and retry."
  );
  expect(sinceParam(new URL("http://localhost/api/rooms/x"))).toBe(0);
  expect(sinceParam(new URL("http://localhost/api/rooms/x?since=4"))).toBe(4);
  expect(sinceParam(new URL("http://localhost/api/rooms/x?since=10"))).toBe(10);
  expect(skipped).toEqual({ handled: false });
});

test("bearer, room, and admin paths reject lookalike urls", async () => {
  const spaced = await send("/api/whoami", {
    headers: { authorization: "Bearer  admin-token" },
  });
  expect(spaced.status).toBe(200);
  const tabbed = await send("/api/whoami", {
    headers: { authorization: "Bearer\tadmin-token" },
  });
  expect(tabbed.status).toBe(200);
  const trailing = await send("/api/whoami", {
    headers: { authorization: "Bearer admin-token extra" },
  });
  expect(trailing.status).toBe(401);
  const prefixed = await send("/api/whoami", {
    headers: { authorization: "xBearer admin-token" },
  });
  expect(prefixed.status).toBe(401);
  const basic = await send("/api/whoami", {
    headers: { authorization: "Basic abc" },
  });
  expect(basic.status).toBe(401);
  expect(await basic.json()).toMatchObject({
    code: "Unauthorized",
    message: "Send a bearer token for an agent, or the admin token.",
    retryable: false,
  });
  const sessionBody = jsonBody({ token: "admin-token" });
  const opened = await api.fetch(
    new Request("http://localhost/viewer/session", {
      body: sessionBody,
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  expect(opened.status).toBe(200);
  expect(await opened.json()).toEqual({ displayName: "human", ok: true });
  const cookie = headerOf(opened, "set-cookie");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Path=/");
  expect(cookie).toContain("SameSite=Lax");
  const fromCookie = await send("/api/whoami", {
    headers: {
      authorization: "Basic abc",
      cookie: cookie.slice(0, cookie.indexOf(";")),
    },
  });
  expect(fromCookie.status).toBe(200);
  const blank = await send("/viewer/session", {
    body: jsonBody({}),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  expect(blank.status).toBe(400);
  expect(await blank.json()).toEqual({
    code: "InvalidArgument",
    details: { constraint: "string", field: "token" },
    message: "Send JSON { token } to start a viewer session.",
    requestId: internalRequestId,
    retryable: false,
  });
  const home = await send("/");
  expect(home.status).toBe(200);
  expect(headerOf(home, "content-type")).toBe("text/html; charset=utf-8");
  expect(await home.text()).toContain("<!doctype html>");
  const roomPage = await send(`/rooms/${roomToken}`);
  expect(roomPage.status).toBe(200);
  expect(await roomPage.text()).toContain(`data-room="${roomToken}"`);
  const extraRoom = await send(`/rooms/${roomToken}/extra`);
  expect(extraRoom.status).toBe(404);
  expect(await extraRoom.json()).toMatchObject({ code: "NotFound" });
  const postedRoom = await send(`/rooms/${roomToken}`, { method: "POST" });
  expect(postedRoom.status).toBe(404);
  const sessionGet = await send("/viewer/session");
  expect(sessionGet.status).toBe(404);
  const prefixedRoom = await send(`/x/api/rooms/${roomToken}/messages`, {
    headers: adminAuth,
  });
  expect(prefixedRoom.status).toBe(404);
  expect(await prefixedRoom.json()).toMatchObject({
    code: "NotFound",
    message: "That path is not served. Use /mcp, /health, or the viewer.",
  });
  const suffixedRoom = await send(`/api/rooms/${roomToken}/messages/extra`, {
    headers: adminAuth,
  });
  expect(suffixedRoom.status).toBe(404);
  expect(await suffixedRoom.json()).toMatchObject({
    message: "That path is not served. Use /mcp, /health, or the viewer.",
  });
  const prefixedRotate = await send(`/x/admin/agents/${agentToken}/rotate`, {
    headers: adminAuth,
    method: "POST",
  });
  expect(prefixedRotate.status).toBe(404);
  expect(await prefixedRotate.json()).toMatchObject({
    message: "That path is not served. Use /mcp, /health, or the viewer.",
  });
  const suffixedRotate = await send(
    `/admin/agents/${agentToken}/rotate/extra`,
    {
      headers: adminAuth,
      method: "POST",
    }
  );
  expect(suffixedRotate.status).toBe(404);
  expect(await suffixedRotate.json()).toMatchObject({
    message: "That path is not served. Use /mcp, /health, or the viewer.",
  });
  const rotateGet = await send(`/admin/agents/${agentToken}/rotate`, {
    headers: adminAuth,
  });
  expect(rotateGet.status).toBe(404);
  expect(await rotateGet.json()).toMatchObject({
    message: "That path is not served. Use /mcp, /health, or the viewer.",
  });
  const createPut = await send("/admin/agents", {
    body: JSON.stringify({ displayName: "ada", kind: "agent" }),
    headers: { ...adminAuth, "content-type": "application/json" },
    method: "PUT",
  });
  expect(createPut.status).toBe(404);
  expect(await createPut.json()).toMatchObject({
    message: "That path is not served. Use /mcp, /health, or the viewer.",
  });
  const prefixedHook = await send(`/x/admin/agents/${agentToken}/webhook`, {
    headers: adminAuth,
    method: "POST",
  });
  expect(prefixedHook.status).toBe(404);
  const suffixedHook = await send(`/admin/agents/${agentToken}/webhook/extra`, {
    headers: adminAuth,
    method: "POST",
  });
  expect(suffixedHook.status).toBe(404);
  expect(await suffixedHook.json()).toMatchObject({
    message: "That path is not served. Use /mcp, /health, or the viewer.",
  });
  const hookGet = await send(`/admin/agents/${agentToken}/webhook`, {
    headers: adminAuth,
  });
  expect(hookGet.status).toBe(404);
});

test("room and admin routes keep method, mention, and socket behavior", async () => {
  const who = Schema.decodeUnknownSync(
    Schema.Struct({ agentId: AgentId, displayName: Schema.String })
  )(await (await send("/api/whoami", { headers: adminAuth })).json());
  const admin = actorFor(who.agentId, "human", true, "human");
  const created = Schema.decodeUnknownSync(
    Schema.Struct({
      agent: Schema.Struct({
        agentId: AgentId,
        displayName: Schema.String,
      }),
      token: Schema.String,
    })
  )(await (await postAgent(send, jsonBody, adminAuth, "ada", "agent")).json());
  const room = await run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.createRoom({
        actor: admin,
        memberIds: [created.agent.agentId],
        name: "routes",
        requestId,
        topic: "kill",
      });
    })
  );
  const adaAuth = {
    authorization: `Bearer ${created.token}`,
    "content-type": "application/json",
  };
  const threads = await send(`/api/rooms/${room.roomId}/threads`, {
    headers: adminAuth,
  });
  expect(threads.status).toBe(200);
  expect(await threads.json()).toEqual({ threads: [] });
  const threadPost = await send(`/api/rooms/${room.roomId}/threads`, {
    headers: adminAuth,
    method: "POST",
  });
  expect(threadPost.status).toBe(404);
  const threadDelete = await send(`/api/rooms/${room.roomId}/threads`, {
    headers: adminAuth,
    method: "DELETE",
  });
  expect(threadDelete.status).toBe(404);
  const mentioned = await send(`/api/rooms/${room.roomId}/messages`, {
    body: jsonBody({ body: "plain", mentions: ["ada"] }),
    headers: { ...adminAuth, "content-type": "application/json" },
    method: "POST",
  });
  expect(mentioned.status).toBe(200);
  const mentionedBody = Schema.decodeUnknownSync(
    Schema.Struct({
      messages: Schema.Array(
        Schema.Struct({ mentions: Schema.Array(Schema.String) })
      ),
    })
  )(await mentioned.json());
  expect(mentionedBody.messages[0]?.mentions).toEqual(["ada"]);
  const untagged = await send(`/api/rooms/${room.roomId}/messages`, {
    body: jsonBody({ body: "open" }),
    headers: { ...adminAuth, "content-type": "application/json" },
    method: "POST",
  });
  expect(untagged.status).toBe(200);
  const untaggedBody = Schema.decodeUnknownSync(
    Schema.Struct({
      messages: Schema.Array(
        Schema.Struct({ mentions: Schema.Array(Schema.String) })
      ),
    })
  )(await untagged.json());
  expect(untaggedBody.messages[0]?.mentions).toEqual(["all"]);
  const listed = await send(`/api/rooms/${room.roomId}/messages`, {
    headers: adminAuth,
  });
  expect(listed.status).toBe(200);
  const page = Schema.decodeUnknownSync(
    Schema.Struct({
      messages: Schema.Array(Schema.Struct({ body: Schema.String })),
    })
  )(await listed.json());
  expect(page.messages.length).toBe(2);
  const postedSocket = await send(`/api/rooms/${room.roomId}/ws`, {
    headers: adminAuth,
    method: "POST",
  });
  expect(postedSocket.status).toBe(404);
  expect(await postedSocket.json()).toMatchObject({
    message: "That path is not served. Use /mcp, /health, or the viewer.",
  });
  const socket = await send(`/api/rooms/${room.roomId}/ws`, {
    headers: { ...adminAuth, upgrade: "websocket" },
  });
  expect(socket.status).toBe(400);
  expect(await socket.text()).toBe(
    "Open the room socket with a websocket upgrade."
  );
  const badHook = await send(`/admin/agents/${created.agent.agentId}/webhook`, {
    body: "not-json",
    headers: adaAuth,
    method: "POST",
  });
  expect(badHook.status).toBe(400);
  expect(await badHook.json()).toMatchObject({
    code: "InvalidArgument",
    details: { constraint: "json", field: "webhookUrl" },
    message:
      "webhookUrl could not be read. Send the JSON body described in the README and retry.",
    retryable: false,
  });
  const emptyHook = await send(
    `/admin/agents/${created.agent.agentId}/webhook`,
    {
      body: jsonBody({}),
      headers: adaAuth,
      method: "POST",
    }
  );
  expect(emptyHook.status).toBe(400);
  expect(await emptyHook.json()).toMatchObject({
    message:
      "webhookUrl could not be read. Send the JSON body described in the README and retry.",
  });
  const rotated = await send(`/admin/agents/${created.agent.agentId}/rotate`, {
    headers: adminAuth,
    method: "POST",
  });
  expect(rotated.status).toBe(200);
  const tokenBody = Schema.decodeUnknownSync(
    Schema.Struct({ token: Schema.String })
  )(await rotated.json());
  expect(tokenBody.token.length).toBeGreaterThan(0);
  expect(tokenBody.token).not.toBe(created.token);
});
