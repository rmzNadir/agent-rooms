import { expect, test } from "bun:test";
import { Effect, Layer, Scope } from "effect";
import { Chat } from "../src/app/chat.ts";
import { writeEnv } from "../src/boundary/external.ts";
import type { Actor } from "../src/domain/actor.ts";
import { RoomId, systemAgentId } from "../src/domain/ids.ts";
import { pauseNotice } from "../src/domain/wake-policy.ts";
import { Directory } from "../src/model/directory.ts";
import { Room } from "../src/model/room.ts";
import { initialRoom, type MessageState } from "../src/model/room-shape.ts";
import { LegacyImport, memoryCredentials } from "../src/runtime/credentials.ts";
import { socketsSkip } from "../src/runtime/sockets.ts";
import { actorFor, chatRunner, requestId } from "./live-chat.ts";
import type { RoomHost } from "./object-host.ts";

const roomId = RoomId.make("room_aaaaaaaaaaaaaaaaaaaaaaaa");

const note = (seq: number, body: string): MessageState => ({
  authorId: systemAgentId,
  authorKind: "agent",
  authorName: "ada",
  body,
  createdAt: seq,
  mentions: ["bea"],
  reactions: [],
  redacted: false,
  replyTo: null,
  seq,
  threadRoot: null,
});

const prior = note(1, "earlier");
const first = note(2, "edge @bea");
const second = note(3, "edge @bea");
const paused = note(4, pauseNotice);
const before = { ...initialRoom, hopCount: 19, messages: [prior], open: true };
const after = {
  ...before,
  hopCount: 20,
  messages: [prior, first, second, paused],
  paused: true,
};

const receipt = (messages: readonly MessageState[]) => ({
  events: messages.map((message) => ({
    _tag: message.body === pauseNotice ? "PauseNoticePosted" : "MessagePosted",
    message,
  })),
  reply: { seq: messages.at(-1)?.seq ?? 0 },
  stream: "Room/room_aaaaaaaaaaaaaaaaaaaaaaaa",
  version: messages.at(-1)?.seq ?? 0,
});

const latch = () => {
  let waiting = 0;
  let release = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });
  return () => {
    waiting += 1;
    if (waiting >= 2) {
      release();
    }
    return opened;
  };
};

const scriptedRooms = () => {
  let reads = 0;
  const wait = latch();
  const state = () =>
    Effect.promise(() => {
      reads += 1;
      const early = reads <= 2;
      return (early ? wait() : Promise.resolve()).then(() =>
        early ? before : after
      );
    });
  let sends = 0;
  const send = () =>
    Effect.sync(() => {
      sends += 1;
      return receipt(sends === 1 ? [first] : [second, paused]);
    });
  return { send, state };
};

const hostFor = async (): Promise<RoomHost> => {
  writeEnv("ALCHEMY_PHASE", "runtime");
  const rooms = scriptedRooms();
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(
    Layer.build(
      Layer.mergeAll(
        Layer.succeed(Room as never, rooms as never),
        Layer.succeed(
          Directory as never,
          {
            send: () => Effect.void,
            state: () => Effect.succeed({ agents: [], rooms: [] }),
          } as never
        ),
        Layer.succeed(LegacyImport, {
          directory: () => Effect.void,
          room: () => Effect.void,
        }),
        memoryCredentials(),
        socketsSkip
      )
    ).pipe(Effect.provideService(Scope.Scope, scope))
  );
  return Layer.succeedContext(context);
};

const post = (run: ReturnType<typeof chatRunner>["run"], actor: Actor) =>
  run(
    Effect.gen(function* () {
      const chat = yield* Chat;
      return yield* chat.postMessage({
        actor,
        body: "edge @bea",
        mentions: ["bea"],
        replyTo: null,
        requestId,
        roomId,
        threadRoot: null,
      });
    })
  );

const pauseCount = (
  pages: readonly { readonly messages: readonly { readonly body: string }[] }[]
) =>
  pages.reduce(
    (count, page) =>
      count +
      page.messages.filter((message) => message.body === pauseNotice).length,
    0
  );

test("two posts at the hop limit pause the room once", async () => {
  const { run } = chatRunner(await hostFor());
  const actor = actorFor(systemAgentId, "ada", false, "agent");
  const pair = await Promise.all([post(run, actor), post(run, actor)]);
  expect(
    after.messages.filter((message) => message.body === pauseNotice)
  ).toHaveLength(1);
  expect(pauseCount(pair)).toBe(1);
});
