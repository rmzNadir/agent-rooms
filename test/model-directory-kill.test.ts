import { expect, test } from "bun:test";
import { Schema } from "effect";
import { RoomId } from "../src/domain/ids.ts";
import {
  Directory,
  RegisterAgent,
  ReserveRoom,
  RotateToken,
} from "../src/model/directory.ts";
import { importPlan } from "../src/model/migrate.ts";
import { Room } from "../src/model/room.ts";
import { MarkRead } from "../src/model/room-commands.ts";
import { applyOpened } from "../src/model/room-evolve.ts";
import { initialRoom } from "../src/model/room-shape.ts";
import { searchBodies } from "../src/model/search.ts";
import { SearchIndex, Transcript, Unread } from "../src/model/views.ts";
import {
  lead,
  leadId,
  legacyMessage,
  message,
  sam,
  samId,
  tagOf,
  tags,
} from "./model-fixture.ts";

const names = (value: object | readonly { readonly _tag: string }[]) =>
  Array.isArray(value) ? value.map((item) => item._tag) : [tagOf(value)];

const live = {
  ...initialRoom,
  leadId,
  members: [lead, { ...sam, joined: true }],
  name: "general",
  open: true,
};

interface DirectorySurface {
  readonly decide: {
    readonly RegisterAgent: (
      state: object,
      command: object
    ) => object | readonly object[];
    readonly ReserveRoom: (
      state: object,
      command: object
    ) => object | readonly object[];
    readonly RotateToken: (
      state: object,
      command: object
    ) => object | readonly object[];
  };
  readonly evolve: {
    readonly AgentRegistered: (
      state: object,
      event: object
    ) => {
      readonly agents: readonly {
        readonly agentId: string;
        readonly tokenHash: string;
      }[];
    };
    readonly RoomReserved: (
      state: object,
      event: object
    ) => {
      readonly rooms: readonly {
        readonly name: string;
        readonly roomId: string;
        readonly topic: string;
      }[];
    };
    readonly TokenRotated: (
      state: object,
      event: object
    ) => {
      readonly agents: readonly {
        readonly agentId: string;
        readonly tokenHash: string;
      }[];
    };
  };
  readonly initial: object;
  readonly state: never;
}

const directory = (
  Directory as object as { readonly definition: DirectorySurface }
).definition;

const roomId = Schema.decodeUnknownSync(RoomId)(
  "room_aaaaaaaaaaaaaaaaaaaaaaaa"
);
const otherId = Schema.decodeUnknownSync(RoomId)(
  "room_bbbbbbbbbbbbbbbbbbbbbbbb"
);

const register = (agentId: typeof leadId, tokenHash: string) =>
  new RegisterAgent({
    agentId,
    displayName: "Named",
    kind: "agent",
    tokenHash,
  });

const head = (value: object | readonly object[]) =>
  Array.isArray(value) ? (value[0] ?? {}) : {};

const enrolled = (state: object, agentId: typeof leadId, tokenHash: string) =>
  directory.evolve.AgentRegistered(
    state,
    head(directory.decide.RegisterAgent(state, register(agentId, tokenHash)))
  );

test("the directory registers a second agent and rotates only that token", () => {
  const withLead = enrolled(directory.initial, leadId, "one");
  const second = directory.decide.RegisterAgent(
    withLead,
    register(samId, "two")
  );
  expect(Array.isArray(second)).toBe(true);
  const withBoth = directory.evolve.AgentRegistered(withLead, head(second));
  const sameHash = directory.decide.RotateToken(
    withBoth,
    new RotateToken({ agentId: samId, tokenHash: "one" })
  );
  expect(names(sameHash)).toEqual(["TokenRotated"]);
  const rotated = directory.decide.RotateToken(
    withBoth,
    new RotateToken({ agentId: samId, tokenHash: "three" })
  );
  const { agents: hashes } = directory.evolve.TokenRotated(
    withBoth,
    head(rotated)
  );
  expect(hashes[0]?.tokenHash).toBe("one");
  expect(hashes[1]?.tokenHash).toBe("three");
});

test("room names are unique across ids and a repeat id replaces one row", () => {
  const withLead = enrolled(directory.initial, leadId, "one");
  expect(
    tagOf(
      directory.decide.ReserveRoom(
        withLead,
        new ReserveRoom({
          leadId,
          memberIds: [samId],
          name: "general",
          roomId,
          topic: "",
        })
      )
    )
  ).toBe("AgentMissing");
  expect(
    tagOf(
      directory.decide.ReserveRoom(
        withLead,
        new ReserveRoom({
          leadId: samId,
          memberIds: [leadId],
          name: "general",
          roomId,
          topic: "",
        })
      )
    )
  ).toBe("AgentMissing");
  const reserved = directory.decide.ReserveRoom(
    withLead,
    new ReserveRoom({
      leadId,
      memberIds: [leadId],
      name: "general",
      roomId,
      topic: "old",
    })
  );
  const withRoom = directory.evolve.RoomReserved(withLead, head(reserved));
  const other = directory.decide.ReserveRoom(
    withRoom,
    new ReserveRoom({
      leadId,
      memberIds: [leadId],
      name: "other",
      roomId: otherId,
      topic: "side",
    })
  );
  const withOther = directory.evolve.RoomReserved(withRoom, head(other));
  expect(
    tagOf(
      directory.decide.ReserveRoom(
        withOther,
        new ReserveRoom({
          leadId,
          memberIds: [leadId],
          name: "general",
          roomId: otherId,
          topic: "clash",
        })
      )
    )
  ).toBe("RoomNameTaken");
  const replaced = directory.decide.ReserveRoom(
    withOther,
    new ReserveRoom({
      leadId,
      memberIds: [leadId],
      name: "general",
      roomId,
      topic: "next",
    })
  );
  const { rooms } = directory.evolve.RoomReserved(withOther, head(replaced));
  expect(rooms).toHaveLength(2);
  expect(rooms[0]?.name).toBe("other");
  expect(rooms[1]?.topic).toBe("next");
  expect(tags(RotateToken, "rejects")).toEqual(["AgentMissing"]);
});

interface TranscriptFold {
  readonly evolve: {
    readonly MessageEdited: (
      state: object,
      event: object
    ) => { readonly messages: readonly { readonly body: string }[] };
    readonly MessagePosted: (
      state: object,
      event: object
    ) => {
      readonly messages: readonly {
        readonly body: string;
        readonly mentions: readonly string[];
        readonly redacted: boolean;
      }[];
    };
    readonly MessageRedacted: (
      state: object,
      event: object
    ) => {
      readonly messages: readonly {
        readonly body: string;
        readonly mentions: readonly string[];
        readonly redacted: boolean;
      }[];
    };
  };
  readonly initial: { readonly roomName: string };
}

interface UnreadFold {
  readonly evolve: {
    readonly PauseNoticePosted: (
      state: object,
      event: object
    ) => { readonly latestSeq: number };
    readonly ReadAdvanced: (
      state: object,
      event: object
    ) => {
      readonly reads: readonly {
        readonly agentId: string;
        readonly lastReadSeq: number;
      }[];
    };
  };
  readonly initial: object;
}

interface SearchFold {
  readonly evolve: {
    readonly MessageEdited: (
      state: object,
      event: object
    ) => {
      readonly entries: readonly {
        readonly body: string;
        readonly seq: number;
      }[];
    };
    readonly MessagePosted: (
      state: object,
      event: object
    ) => { readonly entries: readonly { readonly body: string }[] };
    readonly MessageRedacted: (
      state: object,
      event: object
    ) => {
      readonly entries: readonly {
        readonly body: string;
        readonly redacted: boolean;
      }[];
    };
    readonly PauseNoticePosted: (
      state: object,
      event: object
    ) => { readonly entries: readonly { readonly body: string }[] };
  };
  readonly initial: object;
}

test("views keep one row when a second row is edited, read, or redacted", () => {
  const viewName = (value: object) =>
    (value as { readonly viewName: string }).viewName;
  expect(viewName(Transcript)).toBe("Transcript");
  expect(viewName(Unread)).toBe("Unread");
  expect(viewName(SearchIndex)).toBe("SearchIndex");
  const transcript = (
    Transcript as object as { readonly definition: TranscriptFold }
  ).definition;
  expect(transcript.initial.roomName).toBe("");
  const first = transcript.evolve.MessagePosted(transcript.initial, {
    message: message(1, leadId, "one"),
  });
  const both = transcript.evolve.MessagePosted(first, {
    message: message(2, leadId, "two"),
  });
  const edited = transcript.evolve.MessageEdited(both, {
    body: "edited",
    mentions: ["Sam"],
    seq: 1,
  });
  expect(edited.messages[1]?.body).toBe("two");
  const hidden = transcript.evolve.MessageRedacted(both, { seq: 1 });
  expect(hidden.messages[0]?.body).toBe("[redacted]");
  expect(hidden.messages[0]?.mentions).toEqual([]);
  expect(hidden.messages[0]?.redacted).toBe(true);
  expect(hidden.messages[1]?.body).toBe("two");
  const unread = (Unread as object as { readonly definition: UnreadFold })
    .definition;
  const posted = unread.evolve.PauseNoticePosted(unread.initial, {
    message: message(4, leadId, "paused"),
  });
  expect(posted.latestSeq).toBe(4);
  const leadRead = unread.evolve.ReadAdvanced(posted, {
    agentId: leadId,
    seq: 1,
  });
  const bothReads = unread.evolve.ReadAdvanced(leadRead, {
    agentId: samId,
    seq: 2,
  });
  const moved = unread.evolve.ReadAdvanced(bothReads, {
    agentId: leadId,
    seq: 4,
  });
  expect(moved.reads).toEqual([
    { agentId: samId, lastReadSeq: 2 },
    { agentId: leadId, lastReadSeq: 4 },
  ]);
  const search = (SearchIndex as object as { readonly definition: SearchFold })
    .definition;
  const indexed = search.evolve.MessagePosted(search.initial, {
    message: message(1, leadId, "one"),
  });
  const pair = search.evolve.PauseNoticePosted(indexed, {
    message: message(2, leadId, "two"),
  });
  const changed = search.evolve.MessageEdited(pair, {
    body: "edited",
    mentions: [],
    seq: 1,
  });
  expect(changed.entries[1]?.body).toBe("two");
  expect(changed.entries[0]?.body).toBe("edited");
  const redacted = search.evolve.MessageRedacted(pair, { seq: 2 });
  expect(redacted.entries[0]?.body).toBe("one");
  expect(redacted.entries[1]?.body).toBe("[redacted]");
  expect(redacted.entries[1]?.redacted).toBe(true);
});

test("search skips a redacted body and import keeps mentions beside secrets", () => {
  expect(
    searchBodies(
      [{ authorName: "Lead", body: "secret", redacted: true, seq: 4 }],
      "secret",
      5
    )
  ).toEqual([]);
  const plan = importPlan({
    agents: [],
    rooms: [
      {
        hopCount: 0,
        leadId,
        members: [],
        messages: [legacyMessage(["Sam"])],
        name: "quiet",
        paused: false,
        roomId: "room_aaaaaaaaaaaaaaaaaaaaaaaa",
        topic: "",
      },
    ],
  });
  const [opened, posted] = plan.rooms[0]?.events ?? [];
  expect(opened?._tag).toBe("RoomOpened");
  expect(posted).toEqual(
    expect.objectContaining({
      message: expect.objectContaining({ mentions: ["Sam"] }),
    })
  );
  expect(plan.rooms[0]?.events).toHaveLength(2);
});

interface RoomSurface {
  readonly decide: {
    readonly MarkRead: (
      state: object,
      command: object
    ) => readonly { readonly _tag: string; readonly seq: number }[];
  };
  readonly evolve: {
    readonly LeadTransferred: (
      state: object,
      event: object
    ) => { readonly leadId: string };
    readonly MemberLeft: (
      state: object,
      event: object
    ) => { readonly members: readonly { readonly agentId: string }[] };
    readonly ReadAdvanced: (
      state: object,
      event: object
    ) => { readonly members: readonly { readonly lastReadSeq: number }[] };
  };
  readonly reply: {
    readonly PostMessage: (state: object) => { readonly seq: number };
  };
}

test("the room aggregate decides reads and folds the wrapped events", () => {
  const surface = (Room as object as { readonly definition: RoomSurface })
    .definition;
  expect(surface.reply.PostMessage(initialRoom).seq).toBe(0);
  const read = surface.decide.MarkRead(
    { ...live, messages: [message(1, leadId, "hi")] },
    new MarkRead({ actorId: leadId, seq: 1 })
  );
  expect(read[0]?._tag).toBe("ReadAdvanced");
  const opened = applyOpened(initialRoom, {
    leadId,
    members: [lead, sam],
    name: "general",
    topic: "",
  });
  expect(
    surface.evolve.LeadTransferred(opened, { agentId: samId }).leadId
  ).toBe(samId);
  expect(
    surface.evolve.MemberLeft(opened, { agentId: samId }).members
  ).toHaveLength(1);
  expect(
    surface.evolve.ReadAdvanced(opened, { agentId: leadId, seq: 2 }).members[0]
      ?.lastReadSeq
  ).toBe(2);
});
