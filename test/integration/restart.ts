import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Schema } from "effect";
import {
  createLane,
  type WakeCall,
  writePendingFile,
} from "../../listeners/listener-io.mjs";
import {
  markDelivered,
  resumeUnfinished,
} from "../../listeners/listener-wake.mjs";
import {
  bindPort,
  CreatedSecret,
  type CreatedSecretAgent,
  dieServers,
  type FailedTalk,
  failingPost,
  stopServers,
} from "./restart-fail.ts";
import { observedWake, post, suffix, wakeSeq, workerUrl } from "./support.ts";

const onResumeWake =
  (savedWakes: WakeCall[]) =>
  (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      savedWakes.push(observedWake(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  };

const bindResume = (talk: FailedTalk, savedWakes: WakeCall[]) =>
  Effect.gen(function* () {
    talk.servers.resume = yield* Effect.promise(
      () =>
        new Promise<Server>((resolve) => {
          const receiver = createServer(onResumeWake(savedWakes));
          receiver.listen(0, "127.0.0.1", () => resolve(receiver));
        })
    );
    return yield* bindPort(
      talk.servers.resume,
      talk.servers,
      "The resume listener did not bind."
    );
  });

const inviteRedo = (talk: FailedTalk, redo: CreatedSecretAgent) =>
  Effect.gen(function* () {
    const invited = yield* post(
      `${talk.url}/mcp`,
      {
        id: 5,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { agent_id: redo.agent.agentId, room: talk.roomId },
          name: "invite",
        },
      },
      talk.poster.token
    );
    if (invited.status !== 200) {
      return yield* dieServers(talk.servers, invited.text);
    }
    const joined = yield* post(
      `${talk.url}/mcp`,
      {
        id: 6,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { room: talk.roomId }, name: "join" },
      },
      redo.token
    );
    if (joined.text.includes('"isError":true')) {
      return yield* dieServers(talk.servers, joined.text);
    }
  });

const wakeRedo = (talk: FailedTalk, redo: CreatedSecretAgent) =>
  Effect.gen(function* () {
    const again = yield* post(
      `${talk.url}/mcp`,
      {
        id: 7,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            body: `wake the restarted agent @${redo.agent.displayName}`,
            mentions: [redo.agent.displayName],
            room: talk.roomId,
          },
          name: "post_message",
        },
      },
      talk.poster.token
    );
    if (again.text.includes('"isError":true')) {
      return yield* dieServers(talk.servers, again.text);
    }
  });

const awaitSavedWake = (talk: FailedTalk, savedWakes: WakeCall[]) =>
  Effect.gen(function* () {
    const wakeDeadline = Date.now() + 20_000;
    while (savedWakes.length < 1 && Date.now() < wakeDeadline) {
      yield* Effect.sleep("200 millis");
    }
    return yield* definedWake(talk, savedWakes);
  });

const wakeIds = (
  wake: WakeCall
): wake is WakeCall & { readonly agentId: string; readonly roomId: string } =>
  typeof wake.roomId === "string" && typeof wake.agentId === "string";

const markedOnce = (marks: readonly number[], seq: number) =>
  marks.length === 1 && marks[0] === seq;

const definedWake = (talk: FailedTalk, savedWakes: WakeCall[]) =>
  Effect.gen(function* () {
    const [savedWake] = savedWakes;
    if (
      savedWake === undefined ||
      typeof savedWake.toSeq !== "number" ||
      !wakeIds(savedWake)
    ) {
      return yield* dieServers(talk.servers, JSON.stringify(savedWakes));
    }
    return savedWake;
  });

const replayResume = (
  talk: FailedTalk,
  redo: CreatedSecretAgent,
  savedWake: WakeCall
) =>
  Effect.gen(function* () {
    if (!wakeIds(savedWake)) {
      return yield* dieServers(talk.servers, JSON.stringify(savedWake));
    }
    const { agentId, roomId } = savedWake;
    const resumeDir = mkdtempSync(path.join(tmpdir(), "agent-rooms-resume-"));
    writePendingFile(resumeDir, roomId, agentId, {
      attempts: 1,
      followUp: null,
      phase: "running",
      wake: savedWake,
    });
    const resumeMarks: number[] = [];
    yield* Effect.promise(() =>
      resumeUnfinished(resumeDir, {
        config: {
          agentName: redo.agent.displayName,
          bearerToken: redo.token,
          mcpUrl: talk.mcpUrl,
        },
        lane: createLane(),
        markRead: async (config, payload) => {
          resumeMarks.push(wakeSeq(payload.toSeq));
          await markDelivered(config, payload);
        },
        pendingDir: resumeDir,
        sleep: () => Promise.resolve(),
        start: () => Promise.resolve({ body: { ok: true }, status: 200 }),
      })
    );
    if (!markedOnce(resumeMarks, wakeSeq(savedWake.toSeq))) {
      return yield* dieServers(talk.servers, JSON.stringify(resumeMarks));
    }
    const after = yield* post(
      `${talk.url}/mcp`,
      {
        id: 8,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { room: talk.roomId }, name: "get_unread" },
      },
      redo.token
    );
    if (
      !new RegExp(`lastReadSeq\\\\":${savedWake.toSeq}(?!\\d)`).test(after.text)
    ) {
      return yield* dieServers(talk.servers, after.text);
    }
    stopServers(talk.servers);
  });

const resumeRange = (talk: FailedTalk) =>
  Effect.gen(function* () {
    const savedWakes: WakeCall[] = [];
    const address = yield* bindResume(talk, savedWakes);
    const resumed = yield* post(
      `${talk.url}/admin/agents`,
      {
        displayName: `redo${suffix}`,
        kind: "agent",
        webhookUrl: `http://127.0.0.1:${address.port}/wake`,
      },
      talk.admin
    );
    if (resumed.status !== 200) {
      return yield* dieServers(talk.servers, resumed.text);
    }
    const redo = yield* Schema.decodeEffect(
      Schema.fromJsonString(CreatedSecret)
    )(resumed.text);
    yield* inviteRedo(talk, redo);
    yield* wakeRedo(talk, redo);
    const savedWake = yield* awaitSavedWake(talk, savedWakes);
    yield* replayResume(talk, redo, savedWake);
  });

export const restartListener = Effect.gen(function* () {
  const url = yield* workerUrl;
  const failed = yield* failingPost(url);
  yield* resumeRange(failed);
});
