import { expect, test } from "bun:test";
import { Story } from "alchemy/Domain/Story";
import { Effect, Schema } from "effect";
import { AgentId, RoomId } from "../src/domain/ids.ts";
import { MAX_WAIT_MS, MAX_WAKE_ATTEMPTS } from "../src/domain/wake-policy.ts";
import {
  AgentRegistered,
  AgentRetired,
  Directory,
  RegisterAgent,
  RegisterImported,
  ReleaseRoom,
  ReserveRoom,
  RetireAgent,
  RoomReleased,
  RoomReserved,
  RotateToken,
  TokenRotated,
} from "../src/model/directory.ts";
import { cutoverRule, importPlan } from "../src/model/migrate.ts";
import { RoomNameTaken } from "../src/model/rejections.ts";
import { Rooms, RoomsHandlers } from "../src/model/rooms-model.ts";
import { searchBodies } from "../src/model/search.ts";
import { Webhook, wakeDeadline, wakeRetry } from "../src/model/wake.ts";

const agent = (value: string) => Schema.decodeUnknownSync(AgentId)(value);
const leadId = agent("agent_bbbbbbbbbbbbbbbbbbbbbbbb");
const roomId = Schema.decodeUnknownSync(RoomId)(
  "room_aaaaaaaaaaaaaaaaaaaaaaaa"
);
const otherRoomId = Schema.decodeUnknownSync(RoomId)(
  "room_eeeeeeeeeeeeeeeeeeeeeeee"
);
const story = Story.make(Rooms, {
  externalSystems: [Webhook],
  layer: RoomsHandlers,
});
const directory = Directory.ref("directory");
const run = (effect: Effect.Effect<void, never, never>) =>
  Effect.runPromise(effect);

test("the directory keeps token hashes and refuses a duplicate room name", async () => {
  await run(
    story(
      Story.when(
        directory,
        new RegisterAgent({
          agentId: leadId,
          displayName: "Lead",
          kind: "agent",
          tokenHash: "hash-1",
        })
      ),
      Story.then(
        directory,
        new AgentRegistered({
          agent: {
            agentId: leadId,
            displayName: "Lead",
            kind: "agent",
            tokenHash: "hash-1",
          },
        })
      ),
      Story.when(
        directory,
        new RotateToken({ agentId: leadId, tokenHash: "hash-1" })
      ),
      Story.then(directory),
      Story.when(
        directory,
        new RotateToken({ agentId: leadId, tokenHash: "hash-2" })
      ),
      Story.then(
        directory,
        new TokenRotated({ agentId: leadId, tokenHash: "hash-2" })
      ),
      Story.when(
        directory,
        new ReserveRoom({
          leadId,
          memberIds: [leadId],
          name: "general",
          roomId,
          topic: "",
        })
      ),
      Story.then(
        directory,
        new RoomReserved({
          leadId,
          name: "general",
          roomId,
          topic: "",
        })
      ),
      Story.when(
        directory,
        new ReserveRoom({
          leadId,
          memberIds: [leadId],
          name: "general",
          roomId: otherRoomId,
          topic: "",
        })
      ),
      Story.rejected(new RoomNameTaken({ name: "general" }))
    )
  );
});

test("wake delivery retries within the attempt budget and the deadline is the wait", async () => {
  const seen: number[] = [];
  await Effect.runPromise(
    Effect.sync(() => {
      seen.push(seen.length);
    }).pipe(Effect.repeat(wakeRetry()))
  );
  expect(seen.length).toBe(MAX_WAKE_ATTEMPTS);
  expect(wakeDeadline()).toBe(MAX_WAIT_MS);
});

test("search skips redacted bodies and keeps ascending order", () => {
  const found = searchBodies(
    [
      { authorName: "Lead", body: "alpha", redacted: false, seq: 1 },
      { authorName: "Lead", body: "secret", redacted: true, seq: 2 },
      { authorName: "Sam", body: "Alpha two", redacted: false, seq: 3 },
    ],
    "alpha",
    1
  );
  expect(found.map((entry) => entry.seq)).toEqual([3]);
});

test("the import plan copies secrets beside events and does not embed them", () => {
  const plan = importPlan({
    agents: [
      {
        agentId: leadId,
        displayName: "Lead",
        kind: "agent",
        tokenHash: "hash-1",
      },
    ],
    rooms: [
      {
        hopCount: 4,
        leadId,
        members: [
          {
            agentId: leadId,
            displayName: "Lead",
            joined: true,
            kind: "agent",
            lastReadSeq: 0,
            role: "lead",
            webhookSecret: "whsec-keep",
            webhookUrl: "https://example.test/hook",
          },
        ],
        messages: [
          {
            authorId: leadId,
            authorKind: "agent",
            authorName: "Lead",
            body: "kept",
            createdAt: 1,
            mentions: ["Sam"],
            redacted: false,
            replyTo: null,
            seq: 1,
            threadRoot: null,
          },
        ],
        name: "general",
        paused: true,
        roomId,
        topic: "ship",
      },
    ],
  });
  expect(cutoverRule).toContain("event log is empty");
  expect(plan.secrets).toEqual([
    {
      agentId: leadId,
      webhookSecret: "whsec-keep",
      webhookUrl: "https://example.test/hook",
    },
  ]);
  expect(plan.tokens).toEqual([{ agentId: leadId, tokenHash: "hash-1" }]);
  expect(plan.rooms[0]?.hopCount).toBe(4);
  const encoded = JSON.stringify(plan.rooms[0]?.events);
  expect(encoded.includes("whsec-keep")).toBe(false);
  expect(encoded.includes("hash-1")).toBe(false);
  expect(encoded.includes("kept")).toBe(true);
  expect(encoded.includes("RoomPaused")).toBe(true);
});

test("a second directory import adds nobody", async () => {
  const lead = {
    agentId: leadId,
    displayName: "Lead",
    kind: "agent" as const,
    tokenHash: "hash-1",
  };
  const sam = {
    agentId: agent("agent_cccccccccccccccccccccccc"),
    displayName: "Sam",
    kind: "agent" as const,
    tokenHash: "hash-2",
  };
  await run(
    story(
      Story.when(
        directory,
        new RegisterImported({ agents: [lead], rooms: [] })
      ),
      Story.then(directory, new AgentRegistered({ agent: lead })),
      Story.when(
        directory,
        new RegisterImported({ agents: [lead, sam], rooms: [] })
      ),
      Story.then(directory)
    )
  );
  expect(
    () => new RegisterImported({ agents: [{}], rooms: [] } as never)
  ).toThrow();
});

test("retiring an agent and releasing a room can be repeated", async () => {
  const enrolled = {
    agentId: leadId,
    displayName: "Lead",
    kind: "agent" as const,
    tokenHash: "hash-1",
  };
  const spare = {
    leadId,
    name: "spare",
    roomId: otherRoomId,
    topic: "x",
  };
  await run(
    story(
      Story.when(directory, new RegisterAgent(enrolled)),
      Story.then(directory, new AgentRegistered({ agent: enrolled })),
      Story.when(directory, new ReserveRoom({ ...spare, memberIds: [leadId] })),
      Story.then(directory, new RoomReserved(spare)),
      Story.when(directory, new RetireAgent({ agentId: leadId })),
      Story.then(directory, new AgentRetired({ agentId: leadId })),
      Story.when(directory, new RetireAgent({ agentId: leadId })),
      Story.then(directory),
      Story.when(directory, new ReleaseRoom({ roomId: otherRoomId })),
      Story.then(directory, new RoomReleased({ roomId: otherRoomId })),
      Story.when(directory, new ReleaseRoom({ roomId: otherRoomId })),
      Story.then(directory)
    )
  );
});
