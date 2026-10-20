import { Effect, Schema } from "effect";
import { HttpClient } from "effect/http";
import { readEnv } from "../../src/boundary/external.ts";
import {
  Created,
  defined,
  dieUnless,
  Health,
  httpPrefix,
  post,
  Rpc,
  roomIdIn,
  suffix,
  unreadAdvanced,
  workerUrl,
} from "./support.ts";

const viewerReady = (html: string) =>
  html.includes("agent-rooms") && html.includes("Bearer token");

const roomAccepted = (status: number, text: string) =>
  status === 200 && text.includes("room_");

const storedPost = (text: string) =>
  text.includes("status @human") && !text.includes('"isError":true');

const quietWait = (status: number, text: string) =>
  status === 200 && !text.includes('"isError":true');

const acceptedCall = (status: number, text: string) =>
  status === 200 && !text.includes('"isError":true');

interface CreatedAgent {
  readonly agent: { readonly agentId: string; readonly displayName: string };
  readonly token: string;
}

const establishRoom = (url: string) =>
  Effect.gen(function* () {
    const health = yield* HttpClient.get(`${url}/health`);
    const healthText = yield* health.text;
    yield* Schema.decodeEffect(Schema.fromJsonString(Health))(healthText);

    const home = yield* HttpClient.get(`${url}/`);
    const html = yield* home.text;
    yield* dieUnless(
      viewerReady(html),
      "The viewer did not render the sign-in form."
    );

    const admin = readEnv("AGENT_ROOMS_ADMIN_TOKEN") ?? "";
    const created = yield* post(
      `${url}/admin/agents`,
      { displayName: `ada${suffix}`, kind: "agent", webhookUrl: null },
      admin
    );
    yield* dieUnless(created.status === 200, created.text);
    const agent = yield* Schema.decodeEffect(Schema.fromJsonString(Created))(
      created.text
    );

    const init = yield* post(
      `${url}/mcp`,
      {
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
          protocolVersion: "2025-06-18",
        },
      },
      agent.token
    );
    yield* dieUnless(init.status === 200, init.text);
    yield* Schema.decodeEffect(Schema.fromJsonString(Rpc))(init.text);

    const room = yield* post(
      `${url}/mcp`,
      {
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            members: [],
            name: `launch-${suffix}`,
            topic: "ship v1",
          },
          name: "create_room",
        },
      },
      agent.token
    );
    yield* dieUnless(roomAccepted(room.status, room.text), room.text);
    const roomId = yield* defined(roomIdIn(room.text), room.text);
    return { admin, agent, roomId };
  });

const exchange = (
  url: string,
  admin: string,
  agent: CreatedAgent,
  roomId: string
) =>
  Effect.gen(function* () {
    const listed = yield* post(
      `${url}/mcp`,
      {
        id: 20,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name: "list_rooms" },
      },
      agent.token
    );
    yield* dieUnless(listed.text.includes(roomId), listed.text);

    const untagged = yield* post(
      `${url}/mcp`,
      {
        id: 3,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { body: "hello", mentions: [], room: roomId },
          name: "post_message",
        },
      },
      agent.token
    );
    yield* dieUnless(untagged.text.includes("MentionRequired"), untagged.text);

    const human = yield* post(
      `${url}/admin/agents`,
      { displayName: `sam${suffix}`, kind: "human", webhookUrl: null },
      admin
    );
    yield* dieUnless(human.status === 200, human.text);
    const sam = yield* Schema.decodeEffect(Schema.fromJsonString(Created))(
      human.text
    );
    const invited = yield* post(
      `${url}/mcp`,
      {
        id: 4,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { agent_id: sam.agent.agentId, room: roomId },
          name: "invite",
        },
      },
      agent.token
    );
    yield* dieUnless(invited.status === 200, invited.text);

    const posted = yield* post(
      `${url}/mcp`,
      {
        id: 5,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            body: "status @human",
            mentions: ["human"],
            room: roomId,
          },
          name: "post_message",
        },
      },
      agent.token
    );
    yield* dieUnless(storedPost(posted.text), posted.text);

    const read = yield* post(
      `${url}/mcp`,
      {
        id: 6,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { limit: 20, room: roomId, since: 0 },
          name: "read_messages",
        },
      },
      agent.token
    );
    yield* dieUnless(read.text.includes("status @human"), read.text);
    const unread = yield* post(
      `${url}/mcp`,
      {
        id: 21,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { room: roomId }, name: "get_unread" },
      },
      agent.token
    );
    yield* dieUnless(unreadAdvanced.test(unread.text), unread.text);

    const quiet = yield* post(
      `${url}/mcp`,
      {
        id: 7,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { limit: 10, room: roomId, since: 999, timeout_ms: 400 },
          name: "wait_for_messages",
        },
      },
      agent.token
    );
    yield* dieUnless(quietWait(quiet.status, quiet.text), quiet.text);
    return sam;
  });

const leaveClosesSocket = (
  url: string,
  agent: CreatedAgent,
  sam: CreatedAgent,
  roomId: string
) =>
  Effect.gen(function* () {
    const joined = yield* post(
      `${url}/mcp`,
      {
        id: 22,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { room: roomId }, name: "join" },
      },
      sam.token
    );
    yield* dieUnless(acceptedCall(joined.status, joined.text), joined.text);
    const wsUrl = `${url.replace(httpPrefix, "ws")}/api/rooms/${roomId}/ws`;
    let finishClose: (code: number) => void = () => undefined;
    let failClose: (error: Error) => void = () => undefined;
    const closed = new Promise<number>((resolve, reject) => {
      finishClose = resolve;
      failClose = reject;
    });
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          const pending = new WebSocket(wsUrl, {
            headers: { authorization: `Bearer ${agent.token}` },
          });
          const openTimer = setTimeout(
            () => reject(new Error("socket did not open")),
            5000
          );
          const closeTimer = setTimeout(
            () => failClose(new Error("socket stayed open after leave")),
            5000
          );
          pending.onclose = (event) => {
            clearTimeout(closeTimer);
            finishClose(event.code);
          };
          pending.onopen = () => {
            clearTimeout(openTimer);
            resolve();
          };
          pending.onerror = () => {
            clearTimeout(openTimer);
            clearTimeout(closeTimer);
            reject(new Error("socket failed to open"));
          };
        })
    );
    const left = yield* post(
      `${url}/mcp`,
      {
        id: 23,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { room: roomId }, name: "leave" },
      },
      agent.token
    );
    yield* dieUnless(!left.text.includes('"isError":true'), left.text);
    const closeCode = yield* Effect.promise(() => closed);
    yield* dieUnless(closeCode === 1000, `socket closed with ${closeCode}`);
  });

export const healthConversation = Effect.gen(function* () {
  const url = yield* workerUrl;
  const opened = yield* establishRoom(url);
  const sam = yield* exchange(url, opened.admin, opened.agent, opened.roomId);
  yield* leaveClosesSocket(url, opened.agent, sam, opened.roomId);
});
