import { readEnv } from "../src/boundary/external.ts";
import { HOP_LIMIT } from "../src/domain/wake-policy.ts";
import { requireEnv, type TextReply, textRequest } from "./http-text.ts";
import {
  accepted,
  continuesAt,
  cursorAdvanced,
  deliveryOk,
  healthOk,
  liveKeep,
  liveNames,
  mentionRejected,
  openedAtZero,
  pauseCount,
  untilStatus,
  viewerReady,
  waitUntil,
  wakeBodies,
  wakeNumber,
} from "./live-checks.ts";
import { sweepLive } from "./live-sweep.ts";
import {
  type CreatedLogin,
  createdAgent,
  memberList,
  roomIdIn,
  toolCall,
} from "./room-parse.ts";
import { type Json, readPayload } from "./snapshot-diff.ts";
import { dropReceiver, publishReceiver } from "./wake-receiver.ts";

const httpToWs = /^http/u;
const trailingSlash = /\/$/u;

export interface RoomSocket {
  readonly closeCode: Promise<number>;
  readonly opened: Promise<void>;
}

export interface LiveIo {
  readonly admin: string;
  readonly base: string;
  readonly down: () => Promise<void>;
  readonly now: () => number;
  readonly request: (
    method: string,
    url: string,
    token: string,
    body?: string
  ) => Promise<TextReply>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly socket: (url: string, token: string) => Promise<RoomSocket>;
  readonly suffix: string;
  readonly up: () => Promise<string>;
}

const post = async (
  io: LiveIo,
  token: string,
  id: number,
  name: string,
  args: { readonly [key: string]: Json }
) => {
  const reply = await io.request(
    "POST",
    `${io.base}/mcp`,
    token,
    toolCall(id, name, args)
  );
  if (reply.status !== 200) {
    throw new Error(`${name} failed ${reply.status}`);
  }
  return reply.text;
};

const createLogin = async (
  io: LiveIo,
  name: string,
  kind: string,
  webhook: string | null
) => {
  const reply = await io.request(
    "POST",
    `${io.base}/admin/agents`,
    io.admin,
    JSON.stringify({ displayName: name, kind, webhookUrl: webhook })
  );
  if (reply.status !== 200) {
    throw new Error(`create agent failed ${reply.status}`);
  }
  const created = createdAgent(reply.text);
  if (created === undefined) {
    throw new Error("create agent omitted token");
  }
  return created;
};

const openRoom = async (
  io: LiveIo,
  token: string,
  id: number,
  name: string,
  topic: string,
  members: readonly string[]
) => {
  const text = await post(io, token, id, "create_room", {
    members: [...members],
    name,
    topic,
  });
  const roomId = roomIdIn(text);
  if (roomId === undefined) {
    throw new Error("create room omitted id");
  }
  return roomId;
};

export const healthAndViewer = async (io: LiveIo) => {
  const probe = await io.request("GET", `${io.base}/health`, "");
  if (!healthOk(probe.status, probe.text)) {
    throw new Error(`health ${probe.status}`);
  }
  const home = await io.request("GET", `${io.base}/`, "");
  if (home.status !== 200 || !viewerReady(home.text)) {
    throw new Error(`viewer ${home.status}`);
  }
};

const requireAccepted = (name: string, text: string) => {
  if (!accepted(200, text)) {
    throw new Error(`${name} failed`);
  }
};

const requireGuide = (init: string) => {
  if (!init.includes("skill://agent-rooms/SKILL.md")) {
    throw new Error("initialize omitted the skill");
  }
  if (!init.includes('"resources"')) {
    throw new Error("initialize omitted resources");
  }
};

const requireSkill = async (io: LiveIo, token: string) => {
  const read = await io.request(
    "POST",
    `${io.base}/mcp`,
    token,
    JSON.stringify({
      id: 30,
      jsonrpc: "2.0",
      method: "resources/read",
      params: { uri: "skill://agent-rooms/SKILL.md" },
    })
  );
  if (read.status !== 200 || !read.text.includes("name: agent-rooms")) {
    throw new Error("skill resource missing");
  }
  const got = await io.request(
    "POST",
    `${io.base}/mcp`,
    token,
    JSON.stringify({
      id: 31,
      jsonrpc: "2.0",
      method: "skills/get",
      params: { uri: "skill://agent-rooms/SKILL.md" },
    })
  );
  if (
    got.status !== 200 ||
    !got.text.includes("skill://agent-rooms/SKILL.md")
  ) {
    throw new Error("skills/get missing");
  }
};

export const conversation = async (
  io: LiveIo,
  names: ReturnType<typeof liveNames>,
  left: CreatedLogin,
  right: CreatedLogin
) => {
  const init = await io.request(
    "POST",
    `${io.base}/mcp`,
    left.token,
    JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "live-e2e", version: "0" },
        protocolVersion: "2025-06-18",
      },
    })
  );
  if (init.status !== 200) {
    throw new Error(`initialize ${init.status}`);
  }
  requireGuide(init.text);
  await requireSkill(io, left.token);
  const roomId = await openRoom(io, left.token, 2, names.relay, "ship", [
    right.agentId,
  ]);
  const listed = await post(io, left.token, 3, "list_rooms", {});
  if (!listed.includes(roomId)) {
    throw new Error("room was not listed");
  }
  const untagged = await post(io, left.token, 4, "post_message", {
    body: "hello",
    mentions: [],
    room: roomId,
  });
  if (!mentionRejected(untagged)) {
    throw new Error("untagged agent post was accepted");
  }
  const human = await createLogin(io, names.human, "human", null);
  requireAccepted(
    "invite",
    await post(io, left.token, 5, "invite", {
      agent_id: human.agentId,
      room: roomId,
    })
  );
  requireAccepted(
    "join",
    await post(io, human.token, 6, "join", { room: roomId })
  );
  requireAccepted(
    "post_message",
    await post(io, human.token, 7, "post_message", {
      body: "status",
      room: roomId,
    })
  );
  const read = await post(io, left.token, 8, "read_messages", {
    limit: 20,
    room: roomId,
    since: 0,
  });
  if (!read.includes("status")) {
    throw new Error("human post missing");
  }
  const unread = await post(io, left.token, 9, "get_unread", { room: roomId });
  if (!cursorAdvanced(unread)) {
    throw new Error("read cursor did not advance");
  }
  requireAccepted(
    "wait_for_messages",
    await post(io, left.token, 10, "wait_for_messages", {
      limit: 10,
      room: roomId,
      since: 999,
      timeout_ms: 400,
    })
  );
  const socket = await io.socket(
    `${io.base.replace(httpToWs, "ws")}/api/rooms/${roomId}/ws`,
    left.token
  );
  await socket.opened;
  requireAccepted(
    "leave",
    await post(io, left.token, 11, "leave", { room: roomId })
  );
  const code = await socket.closeCode;
  if (code !== 1000) {
    throw new Error(`socket closed with ${code}`);
  }
};

const relay = async (say: (id: number) => Promise<string>, id: number) => {
  if (id >= HOP_LIMIT + 1) {
    return;
  }
  requireAccepted("post_message", await say(id));
  await relay(say, id + 1);
};

export const hops = async (
  io: LiveIo,
  names: ReturnType<typeof liveNames>,
  left: CreatedLogin,
  right: CreatedLogin
) => {
  const roomId = await openRoom(io, left.token, 30, `${names.relay}b`, "hops", [
    right.agentId,
  ]);
  const say = (id: number) =>
    post(io, left.token, id, "post_message", {
      body: `ping ${id} @${right.displayName}`,
      mentions: [right.displayName],
      room: roomId,
    });
  await relay(say, 2);
  const pair = await Promise.all([say(100), say(101)]);
  if (pauseCount(pair) !== 1) {
    throw new Error(`hop pause count ${pauseCount(pair)}`);
  }
};

const cursorOf = (text: string, agentId: string) =>
  memberList(readPayload(text))?.find((member) => member.agentId === agentId)
    ?.lastReadSeq;

export const wakes = async (
  io: LiveIo,
  names: ReturnType<typeof liveNames>,
  left: CreatedLogin,
  hook: CreatedLogin,
  receiver: string
) => {
  const ready = await untilStatus(
    async () => (await io.request("GET", `${receiver}/wakes`, "")).status,
    200,
    io.now,
    io.sleep
  );
  if (!ready) {
    throw new Error("receiver did not answer");
  }
  const roomId = await openRoom(io, left.token, 40, names.wake, "delivery", [
    hook.agentId,
  ]);
  const say = (id: number, body: string) =>
    post(io, left.token, id, "post_message", {
      body,
      mentions: [hook.displayName],
      room: roomId,
    });
  requireAccepted("post_message", await say(41, `one @${hook.displayName}`));
  const readWakes = async () =>
    wakeBodies((await io.request("GET", `${receiver}/wakes`, "")).text);
  const firstPage = await waitUntil(readWakes, 1, io.now, io.sleep);
  const [first] = firstPage;
  if (first === undefined || !openedAtZero(first) || !deliveryOk(first)) {
    throw new Error("first wake did not open at seq 0");
  }
  const toSeq = wakeNumber(first, "toSeq");
  if (toSeq === undefined) {
    throw new Error("first wake omitted toSeq");
  }
  requireAccepted("post_message", await say(42, `two @${hook.displayName}`));
  const secondPage = await waitUntil(readWakes, 2, io.now, io.sleep);
  const [, second] = secondPage;
  if (second === undefined || !continuesAt(second, toSeq)) {
    throw new Error("second wake did not continue");
  }
  requireAccepted(
    "mark_read",
    await post(io, hook.token, 43, "mark_read", { room: roomId, seq: toSeq })
  );
  const members = await post(io, io.admin, 44, "members", { room: roomId });
  if (cursorOf(members, hook.agentId) !== toSeq) {
    throw new Error("mark_read cursor mismatch");
  }
};

export const runLive = async (io: LiveIo) => {
  let opened = false;
  const keep = liveKeep(io.suffix);
  try {
    await sweepLive(io, keep);
    const receiver = await io.up();
    opened = true;
    await healthAndViewer(io);
    const names = liveNames(io.suffix);
    const left = await createLogin(io, names.left, "agent", null);
    const right = await createLogin(io, names.right, "agent", null);
    await conversation(io, names, left, right);
    await hops(io, names, left, right);
    const hook = await createLogin(io, names.hook, "agent", `${receiver}/wake`);
    await wakes(io, names, left, hook, receiver);
  } finally {
    await sweepLive(io, []);
    if (opened) {
      await io.down();
    }
  }
};

export const openRoomSocket = (
  url: string,
  token: string
): Promise<RoomSocket> => {
  const pending = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("socket did not open")),
      5000
    );
    pending.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    pending.onerror = () => {
      clearTimeout(timer);
      reject(new Error("socket failed"));
    };
  });
  const closeCode = new Promise<number>((resolve) => {
    pending.onclose = (event) => {
      resolve(event.code);
    };
  });
  return Promise.resolve({ closeCode, opened });
};

export const liveIo = (): LiveIo => {
  const base = requireEnv("AGENT_ROOMS_URL").replace(trailingSlash, "");
  const admin = requireEnv("AGENT_ROOMS_ADMIN_TOKEN");
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const account = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const runId = requireEnv("GITHUB_RUN_ID");
  const attempt = readEnv("GITHUB_RUN_ATTEMPT") ?? "1";
  return {
    admin,
    base,
    down: () => dropReceiver(token, account, runId),
    now: () => Date.now(),
    request: (method, url, bearer, body) =>
      textRequest(method, url, bearer, body, "application/json"),
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    socket: openRoomSocket,
    suffix: `${attempt}${runId}`,
    up: () => publishReceiver(fetch, token, account, runId),
  };
};

if (import.meta.main) {
  const sweeping = process.argv.includes("--sweep");
  try {
    if (sweeping) {
      await sweepLive(liveIo(), []);
      console.log("live sweep passed");
    } else {
      await runLive(liveIo());
      console.log("live e2e passed");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "live e2e failed");
    process.exit(1);
  }
}
