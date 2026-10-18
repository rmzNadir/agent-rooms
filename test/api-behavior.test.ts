import { expect, test } from "bun:test";
import { Schema } from "effect";
import {
  adminNameKey,
  adminTokenKey,
  apiOptions,
  apiWorkerName,
  defaultAdminName,
} from "../src/api-worker.ts";
import { adminAuth, httpClient, postAgent } from "./live-chat.ts";
import { startApi } from "./object-host.ts";

const Who = Schema.Struct({
  admin: Schema.Boolean,
  displayName: Schema.String,
  kind: Schema.Literals(["agent", "human"]),
});
const Created = Schema.Struct({
  agent: Schema.Struct({
    agentId: Schema.String,
    displayName: Schema.String,
  }),
  token: Schema.String,
});
const Names = Schema.Array(Schema.Struct({ displayName: Schema.String }));
const TokenBody = Schema.Struct({ token: Schema.String });

const api = await startApi();
const { jsonBody, send } = httpClient(api.fetch);

test("the worker advertises its compatibility date and node flag", () => {
  expect(apiWorkerName).toBe("Api");
  expect(adminTokenKey).toBe("AGENT_ROOMS_ADMIN_TOKEN");
  expect(adminNameKey).toBe("AGENT_ROOMS_ADMIN_NAME");
  expect(defaultAdminName).toBe("human");
  expect(apiOptions.compatibility).toEqual({
    date: "2026-08-31",
    flags: ["nodejs_compat"],
  });
  expect(apiOptions.main).toContain("api-worker.ts");
});

test("the worker http routes enforce auth and persist agents", async () => {
  const health = await send("/health");
  expect(health.status).toBe(200);
  const home = await send("/");
  expect(home.status).toBe(200);
  expect(await home.text()).toContain("agent-rooms");
  const anonymous = await send("/api/whoami");
  expect(anonymous.status).toBe(401);
  const named = await send("/api/whoami", { headers: adminAuth });
  expect(named.status).toBe(200);
  const who = Schema.decodeUnknownSync(Who)(await named.json());
  expect(who).toEqual({
    admin: true,
    displayName: "human",
    kind: "human",
  });
  const created = await postAgent(send, jsonBody, adminAuth, "ada", "agent");
  expect(created.status).toBe(200);
  const ada = Schema.decodeUnknownSync(Created)(await created.json());
  expect(ada.agent.displayName).toBe("ada");
  expect(ada.token.length).toBeGreaterThan(0);
  const listed = await send("/admin/agents", { headers: adminAuth });
  expect(listed.status).toBe(200);
  const agents = Schema.decodeUnknownSync(Names)(await listed.json());
  expect(agents.map((agent) => agent.displayName)).toEqual(["ada", "human"]);
  const adaAuth = { authorization: `Bearer ${ada.token}` };
  const denied = await send("/admin/agents", { headers: adaAuth });
  expect(denied.status).toBe(403);
  const rooms = await send("/api/rooms", { headers: adminAuth });
  expect(rooms.status).toBe(200);
  expect(await rooms.json()).toEqual([]);
  const rotated = await send(`/admin/agents/${ada.agent.agentId}/rotate`, {
    headers: adminAuth,
    method: "POST",
  });
  expect(rotated.status).toBe(200);
  const next = Schema.decodeUnknownSync(TokenBody)(await rotated.json());
  expect(next.token).not.toBe(ada.token);
  const session = await send("/viewer/session", {
    body: jsonBody({ token: "admin-token" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  expect(session.status).toBe(200);
  expect(session.headers.get("set-cookie")).toContain("agent_rooms_token=");
  const missing = await send("/nope");
  expect(missing.status).toBe(404);
});
