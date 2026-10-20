import { expect, test } from "bun:test";
import { Schema } from "effect";
import { LegacyDirectorySchema } from "../src/model/migrate.ts";
import { leadId } from "./model-fixture.ts";

const roomId = "room_aaaaaaaaaaaaaaaaaaaaaaaa";

const room = (members: readonly object[], messages: readonly object[]) => ({
  hopCount: 1,
  leadId,
  members,
  messages,
  name: "ops",
  paused: false,
  roomId,
  topic: "ship",
});

test("legacy schemas reject an empty agent, member, message, and reaction", () => {
  expect(() =>
    Schema.decodeUnknownSync(LegacyDirectorySchema)({
      agents: [{}],
      rooms: [],
    })
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(LegacyDirectorySchema)({
      agents: [],
      rooms: [room([{}], [])],
    })
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(LegacyDirectorySchema)({
      agents: [],
      rooms: [room([], [{}])],
    })
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(LegacyDirectorySchema)({
      agents: [],
      rooms: [
        room(
          [],
          [
            {
              authorId: leadId,
              authorKind: "agent",
              authorName: "Lead",
              body: "kept",
              createdAt: 1,
              mentions: [],
              reactions: [{}],
              redacted: false,
              replyTo: null,
              seq: 1,
              threadRoot: null,
            },
          ]
        ),
      ],
    })
  ).toThrow();
});
