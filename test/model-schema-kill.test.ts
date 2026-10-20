import { expect, test } from "bun:test";
import { Schema } from "effect";
import { RoomId } from "../src/domain/ids.ts";
import { Directory } from "../src/model/directory.ts";
import { SearchIndex, Transcript, Unread } from "../src/model/views.ts";
import { leadId, message } from "./model-fixture.ts";

const roomId = Schema.decodeUnknownSync(RoomId)(
  "room_aaaaaaaaaaaaaaaaaaaaaaaa"
);

test("directory and view schemas keep the stored fields", () => {
  const stored = Schema.decodeUnknownSync(
    (Directory as object as { readonly definition: { readonly state: never } })
      .definition.state
  )({
    agents: [
      {
        agentId: leadId,
        displayName: "Lead",
        kind: "agent",
        tokenHash: "one",
      },
    ],
    rooms: [{ leadId, name: "general", roomId, topic: "topic" }],
  }) as {
    readonly agents: readonly {
      readonly displayName: string;
      readonly tokenHash: string;
    }[];
    readonly rooms: readonly {
      readonly name: string;
      readonly topic: string;
    }[];
  };
  expect(stored.agents[0]?.displayName).toBe("Lead");
  expect(stored.agents[0]?.tokenHash).toBe("one");
  expect(stored.rooms[0]?.name).toBe("general");
  expect(stored.rooms[0]?.topic).toBe("topic");
  const transcript = Schema.decodeUnknownSync(
    (Transcript as object as { readonly definition: { readonly state: never } })
      .definition.state
  )({ messages: [message(1, leadId, "hi")], roomName: "general" }) as {
    readonly messages: readonly { readonly body: string }[];
    readonly roomName: string;
  };
  expect(transcript.roomName).toBe("general");
  expect(transcript.messages[0]?.body).toBe("hi");
  const unread = Schema.decodeUnknownSync(
    (Unread as object as { readonly definition: { readonly state: never } })
      .definition.state
  )({ latestSeq: 4, reads: [{ agentId: leadId, lastReadSeq: 2 }] }) as {
    readonly latestSeq: number;
    readonly reads: readonly { readonly lastReadSeq: number }[];
  };
  expect(unread.latestSeq).toBe(4);
  expect(unread.reads[0]?.lastReadSeq).toBe(2);
  const search = Schema.decodeUnknownSync(
    (
      SearchIndex as object as {
        readonly definition: { readonly state: never };
      }
    ).definition.state
  )({
    entries: [{ authorName: "Lead", body: "hi", redacted: false, seq: 1 }],
  }) as {
    readonly entries: readonly {
      readonly body: string;
      readonly redacted: boolean;
    }[];
  };
  expect(search.entries[0]?.body).toBe("hi");
  expect(search.entries[0]?.redacted).toBe(false);
  const stateOf = (value: object) =>
    (value as { readonly definition: { readonly state: never } }).definition
      .state;
  expect(() =>
    Schema.decodeUnknownSync(stateOf(Directory))({ agents: "no" })
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(stateOf(Directory))({
      agents: [
        {
          agentId: leadId,
          displayName: "Lead",
          kind: "agent",
          tokenHash: 1,
        },
      ],
      rooms: [],
    })
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(stateOf(Directory))({
      agents: [],
      rooms: [{ leadId, name: 1, roomId, topic: "topic" }],
    })
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(stateOf(Transcript))({ messages: [], roomName: 1 })
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(stateOf(Unread))({
      latestSeq: 1,
      reads: [{ agentId: leadId, lastReadSeq: "no" }],
    })
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(stateOf(SearchIndex))({
      entries: [{ authorName: "Lead", body: "hi", redacted: "no", seq: 1 }],
    })
  ).toThrow();
});
