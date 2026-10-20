import { expect, test } from "bun:test";
import { Schema } from "effect";
import { AgentId } from "../src/domain/ids.ts";
import {
  actorFor,
  adminAuth,
  chatEffect,
  chatRunner,
  httpClient,
  postAgent,
  requestId,
} from "./live-chat.ts";
import { startApi } from "./object-host.ts";

const Created = Schema.Struct({
  agent: Schema.Struct({ agentId: AgentId, displayName: Schema.String }),
  token: Schema.String,
});
const Who = Schema.Struct({
  admin: Schema.Boolean,
  agentId: AgentId,
  displayName: Schema.String,
  kind: Schema.Literals(["agent", "human"]),
});

const api = await startApi();
const { failure, run } = chatRunner(api.host);
const { jsonBody, send } = httpClient(api.fetch);

const remove = (path: string, headers: { readonly authorization: string }) =>
  send(path, { headers, method: "DELETE" });

const mint = async (name: string) => {
  const response = await postAgent(send, jsonBody, adminAuth, name, "agent");
  if (response.status !== 200) {
    throw new Error(`create agent failed ${response.status}`);
  }
  return Schema.decodeUnknownSync(Created)(await response.json());
};

const adminActor = () =>
  send("/api/whoami", { headers: adminAuth }).then(async (response) => {
    const who = Schema.decodeUnknownSync(Who)(await response.json());
    return actorFor(who.agentId, "human", true, "human");
  });

const openRoom = (name: string, memberId: AgentId) =>
  adminActor().then((actor) =>
    run(
      chatEffect((chat) =>
        chat.createRoom({
          actor,
          memberIds: [memberId],
          name,
          requestId,
          topic: "ship",
        })
      )
    )
  );

test("deleting an agent frees the display name", async () => {
  const ada = await mint("ada");
  const first = await remove(`/admin/agents/${ada.agent.agentId}`, adminAuth);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true });
  const second = await remove(`/admin/agents/${ada.agent.agentId}`, adminAuth);
  expect(second.status).toBe(200);
  const again = await mint("ada");
  const denied = await remove(`/admin/agents/${again.agent.agentId}`, {
    authorization: `Bearer ${again.token}`,
  });
  expect(denied.status).toBe(403);
  const missing = await remove("/admin/agents/nope", adminAuth);
  expect(missing.status).toBe(404);
});

test("deleting a room frees its name", async () => {
  const bea = await mint("bea");
  const room = await openRoom("ops", bea.agent.agentId);
  const denied = await remove(`/admin/rooms/${room.roomId}`, {
    authorization: `Bearer ${bea.token}`,
  });
  expect(denied.status).toBe(403);
  const gone = await remove(`/admin/rooms/${room.roomId}`, adminAuth);
  expect(gone.status).toBe(200);
  const again = await remove(`/admin/rooms/${room.roomId}`, adminAuth);
  expect(again.status).toBe(200);
  const reopened = await openRoom("ops", bea.agent.agentId);
  expect(reopened.name).toBe("ops");
});

test("members cannot retire agents or release rooms", async () => {
  const cara = await mint("cara");
  const room = await openRoom("denial", cara.agent.agentId);
  const member = actorFor(cara.agent.agentId, "cara", false, "agent");
  const deniedAgent = await failure(
    chatEffect((chat) =>
      chat.retireAgent(member, requestId, cara.agent.agentId)
    )
  );
  expect(deniedAgent).toMatchObject({ operation: "retire_agent" });
  const deniedRoom = await failure(
    chatEffect((chat) => chat.releaseRoom(member, requestId, room.roomId))
  );
  expect(deniedRoom).toMatchObject({ operation: "release_room" });
});
