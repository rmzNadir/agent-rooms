import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Schema } from "effect";
import { createLane, type WakeCall } from "../../listeners/listener-io.mjs";
import { handleWake } from "../../listeners/listener-wake.mjs";
import { readEnv } from "../../src/boundary/external.ts";
import {
  Created,
  post,
  roomIdIn,
  suffix,
  unreadZero,
  wakeSeq,
} from "./support.ts";

const header = (value: string | string[] | undefined) => {
  if (Array.isArray(value)) {
    const [first] = value;
    return first;
  }
  return value;
};

export const CreatedSecret = Schema.Struct({
  agent: Schema.Struct({
    agentId: Schema.String,
    displayName: Schema.String,
  }),
  token: Schema.String,
  webhookSecret: Schema.String,
});

export interface CreatedSecretAgent {
  readonly agent: { readonly agentId: string; readonly displayName: string };
  readonly token: string;
  readonly webhookSecret: string;
}

interface Poster {
  readonly agent: { readonly agentId: string; readonly displayName: string };
  readonly token: string;
}

interface Servers {
  fail: Server | undefined;
  resume: Server | undefined;
}

interface FailState {
  readonly marks: number[];
  readonly mcpUrl: string;
  readonly pending: string;
  secret: string;
  readonly servers: Servers;
  readonly starts: number[];
  token: string;
  readonly url: string;
}

export interface FailedTalk {
  readonly admin: string;
  readonly hook: CreatedSecretAgent;
  readonly mcpUrl: string;
  readonly poster: Poster;
  readonly roomId: string;
  readonly servers: Servers;
  readonly url: string;
}

export const stopServers = (servers: Servers) => {
  servers.fail?.close();
  servers.resume?.close();
};

export const dieServers = (servers: Servers, message: string) => {
  stopServers(servers);
  return Effect.die(message);
};

const freshFailState = (url: string): FailState => ({
  marks: [],
  mcpUrl: `${url}/mcp`,
  pending: mkdtempSync(path.join(tmpdir(), "agent-rooms-live-pending-")),
  secret: "",
  servers: { fail: undefined, resume: undefined },
  starts: [],
  token: "",
  url,
});

const onFailingWake =
  (state: FailState) =>
  async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const { method } = request;
    const signature = header(request.headers["x-agent-rooms-signature"]);
    const timestamp = header(request.headers["x-agent-rooms-timestamp"]);
    const result = await handleWake(
      {
        body,
        ...(method === undefined ? {} : { method }),
        ...(signature === undefined ? {} : { signature }),
        ...(timestamp === undefined ? {} : { timestamp }),
      },
      {
        config: {
          agentName: "ada",
          bearerToken: state.token,
          mcpUrl: state.mcpUrl,
          webhookSecret: state.secret,
        },
        lane: createLane(),
        markRead: (_config, payload: WakeCall) => {
          state.marks.push(wakeSeq(payload.toSeq));
          return Promise.resolve();
        },
        pendingDir: state.pending,
        seenDeliveries: new Map(),
        seenSignatures: new Map(),
        sleep: () => Promise.resolve(),
        start: () => {
          state.starts.push(1);
          return Promise.resolve({ body: { ok: false }, status: 500 });
        },
      }
    );
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
    result.done.catch((error) => {
      console.error(error);
    });
  };

export const bindPort = (
  server: Server | undefined,
  servers: Servers,
  missing: string
) => {
  const address = server === undefined ? null : server.address();
  if (address === null || typeof address === "string") {
    return dieServers(servers, missing);
  }
  return Effect.succeed(address);
};

const bindFailing = (state: FailState) =>
  Effect.gen(function* () {
    state.servers.fail = yield* Effect.promise(
      () =>
        new Promise<Server>((resolve) => {
          const receiver = createServer(onFailingWake(state));
          receiver.listen(0, "127.0.0.1", () => resolve(receiver));
        })
    );
    return yield* bindPort(
      state.servers.fail,
      state.servers,
      "The failing listener did not bind."
    );
  });

const createHook = (state: FailState, address: AddressInfo, admin: string) =>
  Effect.gen(function* () {
    const failed = yield* post(
      `${state.url}/admin/agents`,
      {
        displayName: `fail${suffix}`,
        kind: "agent",
        webhookUrl: `http://127.0.0.1:${address.port}/wake`,
      },
      admin
    );
    if (failed.status !== 200) {
      return yield* dieServers(state.servers, failed.text);
    }
    const hook = yield* Schema.decodeEffect(
      Schema.fromJsonString(CreatedSecret)
    )(failed.text);
    state.secret = hook.webhookSecret;
    state.token = hook.token;
    return hook;
  });

const createPoster = (state: FailState, admin: string) =>
  Effect.gen(function* () {
    const posterCreated = yield* post(
      `${state.url}/admin/agents`,
      { displayName: `tell${suffix}`, kind: "agent", webhookUrl: null },
      admin
    );
    if (posterCreated.status !== 200) {
      return yield* dieServers(state.servers, posterCreated.text);
    }
    return yield* Schema.decodeEffect(Schema.fromJsonString(Created))(
      posterCreated.text
    );
  });

const createRetryRoom = (
  state: FailState,
  hook: CreatedSecretAgent,
  poster: Poster
) =>
  Effect.gen(function* () {
    const room = yield* post(
      `${state.url}/mcp`,
      {
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            members: [hook.agent.agentId],
            name: `retry-${suffix}`,
            topic: "retry",
          },
          name: "create_room",
        },
      },
      poster.token
    );
    if (room.status !== 200) {
      return yield* dieServers(state.servers, room.text);
    }
    const roomId = roomIdIn(room.text);
    if (roomId === undefined) {
      return yield* dieServers(state.servers, room.text);
    }
    return roomId;
  });

const readRoom = (url: string, roomId: string, token: string, id: number) =>
  post(
    `${url}/mcp`,
    {
      id,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: { limit: 20, room: roomId, since: 0 },
        name: "read_messages",
      },
    },
    token
  );

const failureLanded = (transcript: string) =>
  transcript.includes("@human") &&
  transcript.includes("I failed to process messages");

const pollFailure = (state: FailState, roomId: string, poster: Poster) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 20_000;
    let transcript = "";
    while (Date.now() < deadline) {
      const read = yield* readRoom(state.url, roomId, poster.token, 3);
      transcript = read.text;
      if (failureLanded(transcript)) {
        return transcript;
      }
      yield* Effect.sleep("200 millis");
    }
    return transcript;
  });

const attemptsHeld = (state: FailState) =>
  state.starts.length === 3 && state.marks.length === 0;

const heldAttempts = (state: FailState) =>
  Effect.gen(function* () {
    if (!attemptsHeld(state)) {
      return yield* dieServers(
        state.servers,
        `starts=${state.starts.length} marks=${state.marks.join(",")}`
      );
    }
  });

export const failingPost = (url: string) =>
  Effect.gen(function* () {
    const state = freshFailState(url);
    const address = yield* bindFailing(state);
    const admin = readEnv("AGENT_ROOMS_ADMIN_TOKEN") ?? "";
    const hook = yield* createHook(state, address, admin);
    const poster = yield* createPoster(state, admin);
    const roomId = yield* createRetryRoom(state, hook, poster);
    const said = yield* post(
      `${state.url}/mcp`,
      {
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            body: `wake the failing agent @${hook.agent.displayName}`,
            mentions: [hook.agent.displayName],
            room: roomId,
          },
          name: "post_message",
        },
      },
      poster.token
    );
    if (said.text.includes('"isError":true')) {
      return yield* dieServers(state.servers, said.text);
    }
    const transcript = yield* pollFailure(state, roomId, poster);
    if (!failureLanded(transcript)) {
      return yield* dieServers(
        state.servers,
        `${transcript}\nstarts=${state.starts.length}`
      );
    }
    yield* heldAttempts(state);
    const unread = yield* post(
      `${state.url}/mcp`,
      {
        id: 4,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { room: roomId }, name: "get_unread" },
      },
      hook.token
    );
    if (!unreadZero.test(unread.text)) {
      return yield* dieServers(state.servers, unread.text);
    }
    const talk: FailedTalk = {
      admin,
      hook,
      mcpUrl: state.mcpUrl,
      poster,
      roomId,
      servers: state.servers,
      url,
    };
    return talk;
  });
