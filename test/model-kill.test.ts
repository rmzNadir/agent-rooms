import { expect, test } from "bun:test";
import { Schema } from "effect";
import { systemAgentId } from "../src/domain/ids.ts";
import { pauseNotice } from "../src/domain/wake-policy.ts";
import {
  MentionRequired,
  RoomNameTaken,
  UnknownMention,
} from "../src/model/rejections.ts";
import {
  EditMessage,
  ExpireWake,
  InviteMember,
  JoinRoom,
  LeaveRoom,
  MarkRead,
  OpenRoom,
  PostMessage,
  ReactToMessage,
  RecordDelivery,
  RedactMessage,
} from "../src/model/room-commands.ts";
import {
  applyEdited,
  applyInvited,
  applyLead,
  applyLeft,
  applyNotice,
  applyOpened,
  applyPosted,
  applyReacted,
  applyRead,
  applyRedacted,
  applyResumed,
} from "../src/model/room-evolve.ts";
import {
  decideEdit,
  decideExpire,
  decideLeave,
  decidePost,
  decideReact,
  decideRead,
  decideRecord,
  decideRedact,
} from "../src/model/room-rules.ts";
import {
  initialRoom,
  LeadTransferred,
  MemberState,
  MessageState,
  PauseNoticePosted,
  ReadAdvanced,
  RoomState,
  WakeExpired,
} from "../src/model/room-shape.ts";
import { TranscriptLine } from "../src/model/transcript-log.ts";
import {
  human,
  humanId,
  lead,
  leadId,
  message,
  openRoom,
  sam,
  samId,
  tagOf,
  tags,
} from "./model-fixture.ts";

const live = {
  ...openRoom,
  members: [lead, { ...sam, joined: true }, human],
};

const post = (
  state: typeof live,
  body: string,
  authorId: typeof leadId,
  authorKind: "agent" | "human",
  authorName: string,
  replyTo: number | null = null,
  threadRoot: number | null = null
) =>
  decidePost(
    state,
    {
      authorId,
      authorKind,
      authorName,
      body,
      explicitMentions: [],
      replyTo,
      threadRoot,
    },
    5
  );

const names = (value: object | readonly { readonly _tag: string }[]) =>
  Array.isArray(value) ? value.map((item) => item._tag) : [tagOf(value)];

const replyFields = (value: object) =>
  Object.keys(
    (value as { readonly reply: { readonly fields: object } }).reply.fields
  ).join(",");

const commandTag = (value: object) => (value as { readonly tag: string }).tag;

test("every command declares its name, events, rejections, and reply", () => {
  expect(commandTag(InviteMember)).toBe("InviteMember");
  expect(commandTag(JoinRoom)).toBe("JoinRoom");
  expect(commandTag(LeaveRoom)).toBe("LeaveRoom");
  expect(commandTag(EditMessage)).toBe("EditMessage");
  expect(commandTag(RedactMessage)).toBe("RedactMessage");
  expect(commandTag(ReactToMessage)).toBe("ReactToMessage");
  expect(commandTag(MarkRead)).toBe("MarkRead");
  expect(commandTag(RecordDelivery)).toBe("RecordDelivery");
  expect(commandTag(ExpireWake)).toBe("ExpireWake");
  expect(tags(InviteMember, "rejects")).toEqual(["RoomMissing", "NotMember"]);
  expect(tags(JoinRoom, "rejects")).toEqual(["RoomMissing", "NotInvited"]);
  expect(tags(LeaveRoom, "events")).toEqual(["MemberLeft", "LeadTransferred"]);
  expect(tags(LeaveRoom, "rejects")).toEqual([
    "RoomMissing",
    "NotMember",
    "OnlyMember",
  ]);
  expect(tags(EditMessage, "rejects")[0]).toBe("RoomMissing");
  expect(tags(EditMessage, "events")).toEqual(["MessageEdited"]);
  expect(tags(RedactMessage, "rejects")).toEqual([
    "RoomMissing",
    "NotMember",
    "MessageNotFound",
    "NotAuthor",
  ]);
  expect(tags(RedactMessage, "events")).toEqual(["MessageRedacted"]);
  expect(tags(ReactToMessage, "rejects")).toEqual([
    "RoomMissing",
    "NotMember",
    "MessageNotFound",
  ]);
  expect(tags(ReactToMessage, "events")).toEqual(["MessageReacted"]);
  expect(tags(MarkRead, "events")).toEqual(["ReadAdvanced"]);
  expect(tags(MarkRead, "rejects")).toEqual(["RoomMissing", "NotMember"]);
  expect(tags(RecordDelivery, "events")).toEqual(["WakeDelivered"]);
  expect(tags(ExpireWake, "events")).toEqual(["WakeExpired"]);
  expect(replyFields(OpenRoom)).toBe("name");
  expect(replyFields(PostMessage)).toBe("seq");
  expect(new LeadTransferred({ agentId: leadId })._tag).toBe("LeadTransferred");
  expect(new PauseNoticePosted({ message: message(1, leadId, "n") })._tag).toBe(
    "PauseNoticePosted"
  );
  expect(new ReadAdvanced({ agentId: leadId, seq: 1 })._tag).toBe(
    "ReadAdvanced"
  );
  expect(new WakeExpired({ id: "1" })._tag).toBe("WakeExpired");
  expect(new TranscriptLine({ body: "a", seq: 1 }).body).toBe("a");
  expect(new TranscriptLine({ body: "a", seq: 1 }).seq).toBe(1);
  expect(new UnknownMention({ token: "sam" }).token).toBe("sam");
  expect(new RoomNameTaken({ name: "general" }).name).toBe("general");
  expect(new MentionRequired()._tag).toBe("MentionRequired");
});

test("schemas keep every stored field", () => {
  expect(initialRoom.name).toBe("");
  expect(initialRoom.open).toBe(false);
  expect(initialRoom.topic).toBe("");
  const room = Schema.decodeUnknownSync(RoomState)({
    ...initialRoom,
    deliveries: [{ id: "1", status: "expired" }],
    members: [lead],
    messages: [
      {
        ...message(1, leadId, "hi"),
        reactions: [{ agentId: leadId, emoji: "ok" }],
      },
    ],
  });
  expect(room.deliveries[0]?.status).toBe("expired");
  expect(room.members[0]?.displayName).toBe("Lead");
  expect(room.messages[0]?.body).toBe("hi");
  expect(room.messages[0]?.reactions[0]?.emoji).toBe("ok");
  const delivered = Schema.decodeUnknownSync(RoomState)({
    ...initialRoom,
    deliveries: [{ id: "2", status: "delivered" }],
  });
  expect(delivered.deliveries[0]?.status).toBe("delivered");
  const decodedMember = Schema.decodeUnknownSync(MemberState)(lead);
  expect(decodedMember.agentId).toBe(leadId);
  const decodedMessage = Schema.decodeUnknownSync(MessageState)(
    message(1, leadId, "hi")
  );
  expect(decodedMessage.seq).toBe(1);
  expect(() =>
    Schema.decodeUnknownSync(MessageState)({ authorId: 1 })
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(MemberState)({ joined: "no" })
  ).toThrow();
  expect(() => Schema.decodeUnknownSync(RoomState)({ open: "no" })).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(RoomState)({
      ...initialRoom,
      deliveries: [{ id: "1", status: "nope" }],
    })
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(MessageState)({
      ...message(1, leadId, "hi"),
      reactions: [{ agentId: leadId, emoji: 1 }],
    })
  ).toThrow();
});

test("a hop limit pause names the human and a human post resumes", () => {
  const paused = post(
    { ...live, hopCount: 20 },
    "hi @Sam",
    leadId,
    "agent",
    "Lead"
  );
  expect(names(paused)).toEqual([
    "MessagePosted",
    "PauseNoticePosted",
    "RoomPaused",
  ]);
  const notice = Array.isArray(paused) ? paused[1] : undefined;
  expect(notice).toEqual(
    expect.objectContaining({
      message: expect.objectContaining({
        authorId: systemAgentId,
        authorKind: "agent",
        authorName: "room",
        body: pauseNotice,
        mentions: ["human"],
        seq: 2,
      }),
    })
  );
  const again = post(
    { ...live, hopCount: 20, paused: true },
    "hi @Sam",
    leadId,
    "agent",
    "Lead"
  );
  expect(names(again)).toEqual(["MessagePosted"]);
  const resumed = post(
    { ...live, hopCount: 4, paused: true },
    "hello",
    humanId,
    "human",
    "Nadir"
  );
  expect(names(resumed)).toEqual(["MessagePosted", "RoomResumed"]);
});

test("posts reject strangers, untagged agents, and self mentions", () => {
  expect(tagOf(post(openRoom, "hi @Lead", samId, "agent", "Sam"))).toBe(
    "NotMember"
  );
  expect(tagOf(post(openRoom, "hi @Sam", leadId, "agent", "Lead"))).toBe(
    "UnknownMention"
  );
  expect(tagOf(post(live, "hello", leadId, "agent", "Lead"))).toBe(
    "MentionRequired"
  );
  expect(tagOf(post(live, "hi @Lead", leadId, "agent", "Lead"))).toBe(
    "SelfMentionOnly"
  );
});

test("replies inherit the parent thread and reject a missing parent", () => {
  const history = {
    ...live,
    messages: [
      message(1, leadId, "root"),
      { ...message(2, leadId, "child"), replyTo: 1, threadRoot: 1 },
    ],
  };
  const inherited = post(history, "hi @Sam", leadId, "agent", "Lead", 2, null);
  expect(inherited).toEqual([
    expect.objectContaining({
      message: expect.objectContaining({ replyTo: 2, threadRoot: 1 }),
    }),
  ]);
  const explicit = post(
    { ...live, messages: [message(1, leadId, "root")] },
    "hi @Sam",
    leadId,
    "agent",
    "Lead",
    1,
    1
  );
  expect(explicit).toEqual([
    expect.objectContaining({
      message: expect.objectContaining({ threadRoot: 1 }),
    }),
  ]);
  expect(
    tagOf(
      post(
        { ...live, messages: [message(1, leadId, "root")] },
        "hi @Sam",
        leadId,
        "agent",
        "Lead",
        9,
        1
      )
    )
  ).toBe("MessageNotFound");
});

test("the lead hands the room to the next joined agent", () => {
  const left = decideLeave(live, { agentId: leadId });
  expect(left).toEqual([
    expect.objectContaining({ _tag: "MemberLeft", agentId: leadId }),
    expect.objectContaining({ _tag: "LeadTransferred", agentId: samId }),
  ]);
});

test("edits and redacts stay with the author unless an admin acts", () => {
  const withMessage = { ...live, messages: [message(1, leadId, "hi")] };
  expect(
    tagOf(
      decideEdit(openRoom, {
        actorId: samId,
        authorKind: "agent",
        body: "nope",
        explicitMentions: [],
        seq: 1,
      })
    )
  ).toBe("NotMember");
  expect(
    tagOf(
      decideEdit(withMessage, {
        actorId: leadId,
        authorKind: "agent",
        body: "hello",
        explicitMentions: [],
        seq: 1,
      })
    )
  ).toBe("MentionRequired");
  expect(
    tagOf(
      decideRedact(
        { ...openRoom, messages: [message(1, leadId, "hi")] },
        { actorAdmin: false, actorId: samId, seq: 1 }
      )
    )
  ).toBe("NotMember");
  expect(
    tagOf(
      decideRedact(withMessage, { actorAdmin: false, actorId: leadId, seq: 9 })
    )
  ).toBe("MessageNotFound");
  expect(
    tagOf(
      decideRedact(withMessage, {
        actorAdmin: false,
        actorId: humanId,
        seq: 1,
      })
    )
  ).toBe("NotAuthor");
});

test("a second emoji is added and a missing message is rejected", () => {
  const withMessage = applyReacted(
    { ...live, messages: [message(1, leadId, "hi")] },
    { added: true, agentId: leadId, emoji: "ok", seq: 1 }
  );
  expect(
    decideReact(withMessage, { actorId: leadId, emoji: "yes", seq: 1 })
  ).toEqual([expect.objectContaining({ added: true, emoji: "yes" })]);
  const otherAgent = applyReacted(withMessage, {
    added: true,
    agentId: samId,
    emoji: "yes",
    seq: 1,
  });
  expect(
    decideReact(otherAgent, { actorId: leadId, emoji: "yes", seq: 1 })
  ).toEqual([expect.objectContaining({ added: true })]);
  expect(
    tagOf(decideReact(live, { actorId: leadId, emoji: "ok", seq: 4 }))
  ).toBe("MessageNotFound");
  expect(tagOf(decideRead(openRoom, { actorId: samId, seq: 1 }))).toBe(
    "NotMember"
  );
  expect(decideRead(live, { actorId: leadId, seq: 1 })).toEqual([]);
});

test("a new wake id is recorded beside an existing delivery", () => {
  const delivered = {
    ...live,
    deliveries: [{ id: "1", status: "delivered" as const }],
  };
  expect(decideRecord(delivered, "2")).toEqual([
    expect.objectContaining({ _tag: "WakeDelivered", id: "2" }),
  ]);
  expect(decideExpire(delivered, "3")).toEqual([
    expect.objectContaining({ _tag: "WakeExpired", id: "3" }),
  ]);
});

test("folds keep the untouched member, message, and reaction", () => {
  const opened = applyOpened(initialRoom, {
    leadId,
    members: [lead, human],
    name: "general",
    topic: "topic",
  });
  const invited = applyInvited(opened, sam);
  const [stayed] = applyLeft(invited, samId).members;
  expect(stayed?.agentId).toBe(leadId);
  const led = applyLead(invited, samId);
  expect(led.members[2]?.role).toBe("lead");
  expect(led.members[2]?.displayName).toBe("Sam");
  expect(led.members[1]?.role).toBe("member");
  const read = applyRead(invited, { agentId: samId, seq: 3 });
  expect(read.members[0]?.lastReadSeq).toBe(0);
  expect(read.members[2]?.lastReadSeq).toBe(3);
  const posted = applyPosted(
    { ...opened, hopCount: 4 },
    { message: message(1, leadId, "hi"), targets: [] }
  );
  expect(posted.hopCount).toBe(4);
  const humanPost = applyPosted(
    { ...opened, hopCount: 4 },
    {
      message: { ...message(1, humanId, "hi"), authorKind: "human" },
      targets: [samId],
    }
  );
  expect(humanPost.hopCount).toBe(0);
  const second = applyPosted(posted, {
    message: message(2, leadId, "next"),
    targets: [],
  });
  const edited = applyEdited(second, {
    body: "edited",
    mentions: ["Sam"],
    seq: 1,
  });
  expect(edited.messages[0]?.mentions).toEqual(["Sam"]);
  expect(edited.messages[1]?.body).toBe("next");
  const reacted = applyReacted(
    applyReacted(posted, { added: true, agentId: leadId, emoji: "ok", seq: 1 }),
    { added: true, agentId: leadId, emoji: "yes", seq: 1 }
  );
  const [kept] = applyReacted(reacted, {
    added: false,
    agentId: leadId,
    emoji: "ok",
    seq: 1,
  }).messages;
  expect(kept?.reactions).toEqual([{ agentId: leadId, emoji: "yes" }]);
  const [other] = applyReacted(
    applyReacted(posted, { added: true, agentId: samId, emoji: "ok", seq: 1 }),
    { added: false, agentId: leadId, emoji: "ok", seq: 1 }
  ).messages;
  expect(other?.reactions).toEqual([{ agentId: samId, emoji: "ok" }]);
  const [redacted] = applyRedacted(
    applyPosted(opened, {
      message: {
        ...message(1, leadId, "hi"),
        mentions: ["Sam"],
        reactions: [{ agentId: leadId, emoji: "ok" }],
      },
      targets: [],
    }),
    1
  ).messages;
  expect(redacted?.body).toBe("[redacted]");
  expect(redacted?.mentions).toEqual([]);
  expect(redacted?.reactions).toEqual([]);
  expect(
    applyNotice(opened, message(2, leadId, "paused")).messages
  ).toHaveLength(1);
  expect(applyResumed({ ...opened, hopCount: 4, paused: true }).paused).toBe(
    false
  );
});
