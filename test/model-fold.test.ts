import { expect, test } from "bun:test";
import { Schema } from "effect";
import { RoomId } from "../src/domain/ids.ts";
import {
  Directory,
  RegisterAgent,
  ReserveRoom,
  RotateToken,
} from "../src/model/directory.ts";
import { Room } from "../src/model/room.ts";
import {
  applyDelivery,
  applyEdited,
  applyInvited,
  applyJoined,
  applyLead,
  applyLeft,
  applyNotice,
  applyOpened,
  applyPaused,
  applyPosted,
  applyReacted,
  applyRead,
  applyRedacted,
  applyResumed,
} from "../src/model/room-evolve.ts";
import {
  decideEdit,
  decideExpire,
  decidePost,
  decideReact,
  decideRead,
  decideRecord,
  decideRedact,
} from "../src/model/room-rules.ts";
import { initialRoom } from "../src/model/room-shape.ts";
import { SearchIndex, Transcript, Unread } from "../src/model/views.ts";
import {
  agent,
  human,
  humanId,
  lead,
  leadId,
  message,
  openRoom,
  sam,
  samId,
  tagOf,
} from "./model-fixture.ts";

test("evolve folds each room event", () => {
  const opened = applyOpened(initialRoom, {
    leadId,
    members: [lead],
    name: "general",
    topic: "topic",
  });
  expect(opened.open).toBe(true);
  expect(opened.topic).toBe("topic");
  const invited = applyInvited(opened, sam);
  expect(invited.members).toHaveLength(2);
  expect(applyJoined(invited, samId).members[1]?.joined).toBe(true);
  expect(applyLeft(invited, samId).members).toHaveLength(1);
  expect(applyLead(opened, leadId).leadId).toBe(leadId);
  const posted = applyPosted(opened, {
    message: message(1, leadId, "hi"),
    targets: [samId],
  });
  expect(posted.hopCount).toBe(1);
  const humanPost = applyPosted(opened, {
    message: { ...message(1, humanId, "hi"), authorKind: "human" },
    targets: [],
  });
  expect(humanPost.hopCount).toBe(0);
  const notice = applyNotice(opened, message(2, leadId, "paused"));
  expect(notice.paused).toBe(true);
  expect(applyPaused(opened).paused).toBe(true);
  expect(applyResumed({ ...opened, hopCount: 4, paused: true }).hopCount).toBe(
    0
  );
  const edited = applyEdited(posted, {
    body: "edited",
    mentions: ["Sam"],
    seq: 1,
  });
  const [editedMessage] = edited.messages;
  expect(editedMessage?.body).toBe("edited");
  const [redacted] = applyRedacted(posted, 1).messages;
  expect(redacted?.redacted).toBe(true);
  const reaction = applyReacted(posted, {
    added: true,
    agentId: leadId,
    emoji: "ok",
    seq: 1,
  });
  const [reactedMessage] = reaction.messages;
  expect(reactedMessage?.reactions).toHaveLength(1);
  const [cleared] = applyReacted(reaction, {
    added: false,
    agentId: leadId,
    emoji: "ok",
    seq: 1,
  }).messages;
  expect(cleared?.reactions).toHaveLength(0);
  const [reader] = applyRead(opened, { agentId: leadId, seq: 3 }).members;
  expect(reader?.lastReadSeq).toBe(3);
  const [delivery] = applyDelivery(opened, "9", "expired").deliveries;
  expect(delivery?.status).toBe("expired");
});

interface HandlerSet {
  readonly decide: {
    readonly RegisterAgent: (
      state: object,
      command: object
    ) => object | readonly { readonly _tag: string }[];
    readonly ReserveRoom: (
      state: object,
      command: object
    ) => object | readonly object[];
    readonly RotateToken: (
      state: object,
      command: object
    ) => object | readonly { readonly _tag: string }[];
  };
  readonly evolve: {
    readonly AgentRegistered: (state: object, event: object) => object;
  };
  readonly initial: object;
}

interface ViewSet {
  readonly evolve: {
    readonly MessagePosted: (
      state: object,
      event: object
    ) => {
      readonly latestSeq: number;
    };
    readonly MessageRedacted: (
      state: object,
      event: object
    ) => { readonly entries: readonly { readonly redacted: boolean }[] };
    readonly RoomOpened: (
      state: object,
      event: object
    ) => { readonly roomName: string };
  };
  readonly initial: object;
}

const handlers = (value: object) =>
  value as { readonly definition: HandlerSet };
const view = (value: object) => value as { readonly definition: ViewSet };

test("the directory and the views fold their events", () => {
  const { decide, evolve, initial: empty } = handlers(Directory).definition;
  const registered = decide.RegisterAgent(
    empty,
    new RegisterAgent({
      agentId: leadId,
      displayName: "Lead",
      kind: "agent",
      tokenHash: "hash",
    })
  );
  const first = Array.isArray(registered) ? registered[0] : undefined;
  expect(first?._tag).toBe("AgentRegistered");
  const withAgent = evolve.AgentRegistered(empty, first ?? {});
  expect(
    tagOf(
      decide.RegisterAgent(
        withAgent,
        new RegisterAgent({
          agentId: leadId,
          displayName: "Lead",
          kind: "agent",
          tokenHash: "hash",
        })
      )
    )
  ).toBe("AgentAlreadyRegistered");
  const roomId = Schema.decodeUnknownSync(RoomId)(
    "room_aaaaaaaaaaaaaaaaaaaaaaaa"
  );
  const reserved = decide.ReserveRoom(
    withAgent,
    new ReserveRoom({
      leadId,
      memberIds: [leadId],
      name: "general",
      roomId,
      topic: "",
    })
  );
  expect(Array.isArray(reserved)).toBe(true);
  const rotated = decide.RotateToken(
    withAgent,
    new RotateToken({ agentId: leadId, tokenHash: "next" })
  );
  expect(Array.isArray(rotated) && rotated[0]?._tag).toBe("TokenRotated");
  expect(
    decide.RotateToken(
      withAgent,
      new RotateToken({ agentId: leadId, tokenHash: "hash" })
    )
  ).toEqual([]);
  expect(
    tagOf(
      decide.RotateToken(
        empty,
        new RotateToken({ agentId: leadId, tokenHash: "hash" })
      )
    )
  ).toBe("AgentMissing");
  const transcriptView = view(Transcript).definition;
  const transcript = transcriptView.evolve.RoomOpened(transcriptView.initial, {
    name: "general",
  });
  expect(transcript.roomName).toBe("general");
  const unreadView = view(Unread).definition;
  const unread = unreadView.evolve.MessagePosted(unreadView.initial, {
    message: message(4, leadId, "hi"),
  });
  expect(unread.latestSeq).toBe(4);
  const searched = view(SearchIndex).definition.evolve.MessageRedacted(
    {
      entries: [{ authorName: "Lead", body: "hi", redacted: false, seq: 4 }],
    },
    { seq: 4 }
  );
  const [entry] = searched.entries;
  expect(entry?.redacted).toBe(true);
});

interface RoomSurface {
  readonly evolve: {
    readonly MessagePosted: (
      state: object,
      event: object
    ) => { readonly hopCount: number };
    readonly PauseNoticePosted: (
      state: object,
      event: object
    ) => {
      readonly paused: boolean;
    };
    readonly RoomPaused: (state: object) => { readonly paused: boolean };
    readonly RoomResumed: (state: object) => { readonly hopCount: number };
    readonly WakeDelivered: (
      state: object,
      event: object
    ) => { readonly deliveries: readonly { readonly status: string }[] };
    readonly WakeExpired: (
      state: object,
      event: object
    ) => { readonly deliveries: readonly { readonly status: string }[] };
  };
  readonly reply: {
    readonly OpenRoom: (state: object) => { readonly name: string };
    readonly PostMessage: (state: object) => { readonly seq: number };
  };
}

test("the room aggregate applies each event and reply", () => {
  const surface = (Room as object as { readonly definition: RoomSurface })
    .definition;
  const posted = surface.evolve.MessagePosted(initialRoom, {
    message: message(1, leadId, "hi"),
    targets: [samId],
  });
  expect(posted.hopCount).toBe(1);
  expect(
    surface.evolve.PauseNoticePosted(initialRoom, {
      message: message(2, leadId, "paused"),
    }).paused
  ).toBe(true);
  expect(surface.evolve.RoomPaused(initialRoom).paused).toBe(true);
  expect(surface.evolve.RoomResumed(initialRoom).hopCount).toBe(0);
  const [delivered] = surface.evolve.WakeDelivered(initialRoom, {
    id: "1",
  }).deliveries;
  expect(delivered?.status).toBe("delivered");
  const [expired] = surface.evolve.WakeExpired(initialRoom, {
    id: "2",
  }).deliveries;
  expect(expired?.status).toBe("expired");
  const opened = applyOpened(initialRoom, {
    leadId,
    members: [lead],
    name: "general",
    topic: "",
  });
  expect(surface.reply.OpenRoom(opened).name).toBe("general");
  expect(surface.reply.PostMessage(posted).seq).toBe(1);
});

interface TranscriptSurface {
  readonly computed: {
    readonly markdown: (state: {
      readonly messages: readonly object[];
      readonly roomName: string;
    }) => string;
  };
  readonly evolve: {
    readonly MessageEdited: (
      state: object,
      event: object
    ) => { readonly messages: readonly { readonly body: string }[] };
    readonly MessageRedacted: (
      state: object,
      event: object
    ) => { readonly messages: readonly { readonly body: string }[] };
    readonly PauseNoticePosted: (
      state: object,
      event: object
    ) => {
      readonly messages: readonly { readonly body: string }[];
      readonly roomName: string;
    };
  };
  readonly initial: {
    readonly messages: readonly object[];
    readonly roomName: string;
  };
}

test("transcript views keep the body, the redaction, and the markdown", () => {
  const transcript = (
    Transcript as object as { readonly definition: TranscriptSurface }
  ).definition;
  const opened = transcript.evolve.PauseNoticePosted(transcript.initial, {
    message: message(1, leadId, "paused"),
  });
  const [notice] = opened.messages;
  expect(notice?.body).toBe("paused");
  const edited = transcript.evolve.MessageEdited(opened, {
    body: "edited",
    mentions: ["Sam"],
    seq: 1,
  });
  const [next] = edited.messages;
  expect(next?.body).toBe("edited");
  const redacted = transcript.evolve.MessageRedacted(edited, { seq: 1 });
  const [hidden] = redacted.messages;
  expect(hidden?.body).toBe("[redacted]");
  expect(transcript.computed.markdown(opened)).toContain("paused");
});

test("edits, reactions, reads, and deliveries keep the room rules", () => {
  const live = {
    ...openRoom,
    members: [lead, { ...sam, joined: true }, human],
  };
  const stranger = decidePost(
    live,
    {
      authorId: humanId,
      authorKind: "human",
      authorName: "Nadir",
      body: "hi @Nobody",
      explicitMentions: [],
      replyTo: null,
      threadRoot: null,
    },
    5
  );
  expect(tagOf(stranger)).toBe("UnknownMention");
  const withMessage = { ...live, messages: [message(1, leadId, "hi")] };
  const edited = decideEdit(withMessage, {
    actorId: leadId,
    authorKind: "agent",
    body: "edited @Sam",
    explicitMentions: [],
    seq: 1,
  });
  expect(edited).toEqual([expect.objectContaining({ _tag: "MessageEdited" })]);
  expect(
    tagOf(
      decideEdit(withMessage, {
        actorId: humanId,
        authorKind: "human",
        body: "nope",
        explicitMentions: [],
        seq: 1,
      })
    )
  ).toBe("NotAuthor");
  expect(
    tagOf(
      decideEdit(withMessage, {
        actorId: leadId,
        authorKind: "agent",
        body: "x @Sam",
        explicitMentions: [],
        seq: 4,
      })
    )
  ).toBe("MessageNotFound");
  const redacted = decideRedact(withMessage, {
    actorAdmin: false,
    actorId: leadId,
    seq: 1,
  });
  expect(redacted).toEqual([
    expect.objectContaining({ _tag: "MessageRedacted" }),
  ]);
  expect(
    decideRedact(withMessage, { actorAdmin: true, actorId: humanId, seq: 1 })
  ).toEqual([expect.objectContaining({ _tag: "MessageRedacted" })]);
  const reacted = decideReact(withMessage, {
    actorId: leadId,
    emoji: "ok",
    seq: 1,
  });
  expect(reacted).toEqual([expect.objectContaining({ added: true })]);
  const reactedState = applyReacted(withMessage, {
    added: true,
    agentId: leadId,
    emoji: "ok",
    seq: 1,
  });
  const removed = decideReact(reactedState, {
    actorId: leadId,
    emoji: "ok",
    seq: 1,
  });
  expect(removed).toEqual([expect.objectContaining({ added: false })]);
  expect(
    tagOf(
      decideReact(withMessage, {
        actorId: agent("agent_ffffffffffffffffffffffff"),
        emoji: "ok",
        seq: 1,
      })
    )
  ).toBe("NotMember");
  expect(decideRead(withMessage, { actorId: leadId, seq: 1 })).toEqual([
    expect.objectContaining({ _tag: "ReadAdvanced" }),
  ]);
  const readState = applyRead(withMessage, { agentId: leadId, seq: 1 });
  expect(decideRead(readState, { actorId: leadId, seq: 1 })).toEqual([]);
  expect(decideRecord(live, "1")).toEqual([
    expect.objectContaining({ _tag: "WakeDelivered" }),
  ]);
  const delivered = applyDelivery(live, "1", "delivered");
  expect(decideRecord(delivered, "1")).toEqual([]);
  expect(decideExpire(live, "2")).toEqual([
    expect.objectContaining({ _tag: "WakeExpired" }),
  ]);
  expect(decideExpire(delivered, "1")).toEqual([]);
});
