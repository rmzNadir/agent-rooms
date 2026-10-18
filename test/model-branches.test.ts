import { expect, test } from "bun:test";
import { DateTime } from "effect";
import {
  AgentRegistered,
  Directory,
  RegisterAgent,
  ReserveRoom,
  RoomReserved,
  RotateToken,
  TokenRotated,
} from "../src/model/directory.ts";
import {
  inviteAllowed,
  invitedMember,
  nextLead,
} from "../src/model/membership.ts";
import { importPlan } from "../src/model/migrate.ts";
import {
  AgentAlreadyRegistered,
  AgentMissing,
  AlreadyOpen,
  MentionRequired,
  MessageNotFound,
  NotAuthor,
  NotInvited,
  NotMember,
  OnlyMember,
  RoomMissing,
  RoomNameTaken,
  SelfMentionOnly,
  UnknownMention,
} from "../src/model/rejections.ts";
import { Room } from "../src/model/room.ts";
import {
  InviteMember,
  OpenRoom,
  PostMessage,
} from "../src/model/room-commands.ts";
import {
  decideEdit,
  decideInvite,
  decideJoin,
  decideLeave,
  decidePost,
  decideReact,
  decideRead,
  decideRedact,
  epochMillis,
} from "../src/model/room-rules.ts";
import {
  initialRoom,
  LeadTransferred,
  MemberInvited,
  MemberJoined,
  MemberLeft,
  MessageEdited,
  MessagePosted,
  MessageReacted,
  MessageRedacted,
  PauseNoticePosted,
  ReadAdvanced,
  RoomOpened,
  RoomPaused,
  RoomResumed,
  WakeDelivered,
  WakeExpired,
} from "../src/model/room-shape.ts";
import { Rooms } from "../src/model/rooms-model.ts";
import { searchBodies } from "../src/model/search.ts";
import {
  TranscriptLine,
  TranscriptLines,
  TranscriptLog,
} from "../src/model/transcript-log.ts";
import {
  WakeDelivery,
  Webhook,
  wakeDeliveryOptions,
} from "../src/model/wake.ts";
import {
  agent,
  human,
  humanId,
  keys,
  lead,
  leadId,
  legacyMessage,
  member,
  message,
  named,
  openRoom,
  sam,
  samId,
  tagOf,
  tags,
} from "./model-fixture.ts";

test("commands, events, and rejections keep their names and fields", () => {
  expect(keys(RoomOpened)).toBe("_tag,leadId,members,name,topic");
  expect(keys(MemberInvited)).toBe("_tag,member");
  expect(keys(MemberJoined)).toBe("_tag,agentId");
  expect(keys(MemberLeft)).toBe("_tag,agentId");
  expect(keys(LeadTransferred)).toBe("_tag,agentId");
  expect(keys(MessagePosted)).toBe("_tag,message,targets");
  expect(keys(PauseNoticePosted)).toBe("_tag,message");
  expect(keys(MessageEdited)).toBe("_tag,body,mentions,seq");
  expect(keys(MessageRedacted)).toBe("_tag,seq");
  expect(keys(MessageReacted)).toBe("_tag,added,agentId,emoji,seq");
  expect(keys(ReadAdvanced)).toBe("_tag,agentId,seq");
  expect(keys(WakeDelivered)).toBe("_tag,id");
  expect(keys(WakeExpired)).toBe("_tag,id");
  expect(keys(OpenRoom)).toBe("_tag,leadId,members,name,topic");
  expect(keys(InviteMember)).toBe("_tag,actorAdmin,actorId,member");
  expect(keys(PostMessage)).toBe(
    "_tag,authorId,authorKind,authorName,body,explicitMentions,replyTo,threadRoot"
  );
  expect(new RoomPaused()._tag).toBe("RoomPaused");
  expect(new RoomResumed()._tag).toBe("RoomResumed");
  expect(tags(OpenRoom, "rejects")).toEqual(["AlreadyOpen"]);
  expect(tags(PostMessage, "rejects")).toEqual([
    "RoomMissing",
    "NotMember",
    "MessageNotFound",
    "MentionRequired",
    "UnknownMention",
    "SelfMentionOnly",
  ]);
  expect(tags(OpenRoom, "events")).toEqual(["RoomOpened"]);
  expect(new AlreadyOpen()._tag).toBe("AlreadyOpen");
  expect(new RoomMissing()._tag).toBe("RoomMissing");
  expect(new NotMember()._tag).toBe("NotMember");
  expect(new NotInvited()._tag).toBe("NotInvited");
  expect(new OnlyMember()._tag).toBe("OnlyMember");
  expect(new MentionRequired()._tag).toBe("MentionRequired");
  expect(new UnknownMention({ token: "x" })._tag).toBe("UnknownMention");
  expect(new SelfMentionOnly()._tag).toBe("SelfMentionOnly");
  expect(new NotAuthor()._tag).toBe("NotAuthor");
  expect(new MessageNotFound()._tag).toBe("MessageNotFound");
  expect(new AgentAlreadyRegistered()._tag).toBe("AgentAlreadyRegistered");
  expect(new AgentMissing()._tag).toBe("AgentMissing");
  expect(new RoomNameTaken({ name: "general" })._tag).toBe("RoomNameTaken");
  expect(keys(AgentRegistered)).toBe("_tag,agent");
  expect(keys(TokenRotated)).toBe("_tag,agentId,tokenHash");
  expect(keys(RoomReserved)).toBe("_tag,leadId,name,roomId,topic");
  expect(keys(RegisterAgent)).toBe("_tag,agentId,displayName,kind,tokenHash");
  expect(keys(RotateToken)).toBe("_tag,agentId,tokenHash");
  expect(keys(ReserveRoom)).toBe("_tag,leadId,memberIds,name,roomId,topic");
  expect(tags(RegisterAgent, "rejects")).toEqual(["AgentAlreadyRegistered"]);
  expect(tags(ReserveRoom, "rejects")).toEqual([
    "RoomNameTaken",
    "AgentMissing",
  ]);
  expect(named(WakeDelivery).policyName).toBe("WakeDelivery");
  expect(named(Webhook).systemName).toBe("Webhook");
  expect(
    Object.keys(named(Webhook).ops.deliver.args)
      .sort((left, right) => (left < right ? -1 : 1))
      .join(",")
  ).toBe("body,roomId");
  expect(Object.keys(named(Webhook).ops.deliver.success).join(",")).toBe(
    "status"
  );
  expect(named(TranscriptLines).projectionName).toBe("TranscriptLines");
  expect(new TranscriptLine({ body: "a", seq: 1 })._tag).toBe("TranscriptLine");
  expect(named(TranscriptLog).key).toBe("alchemy/Domain/Stream/TranscriptLog");
  expect(named(Rooms).modelName).toBe("Rooms");
  expect(named(Room).aggregateName).toBe("Room");
  expect(named(Directory).aggregateName).toBe("Directory");
  expect(wakeDeliveryOptions.retry).toBeDefined();
});

test("membership, search, and the import plan cover each branch", () => {
  expect(inviteAllowed(false, false)).toBe(false);
  expect(inviteAllowed(false, true)).toBe(true);
  expect(invitedMember(undefined)).toBe(false);
  expect(invitedMember(lead)).toBe(true);
  expect(nextLead("member", [human])).toBeUndefined();
  expect(nextLead("lead", [human, lead])?.agentId).toBe(leadId);
  expect(nextLead("lead", [human])?.kind).toBe("human");
  const found = searchBodies(
    [
      { authorName: "Lead", body: "Hello", redacted: false, seq: 1 },
      { authorName: "Sam", body: "hello again", redacted: false, seq: 3 },
      { authorName: "Lead", body: "secret", redacted: true, seq: 4 },
    ],
    "HELLO",
    2
  );
  expect(found.map((entry) => entry.seq)).toEqual([1, 3]);
  const roomId = "room_aaaaaaaaaaaaaaaaaaaaaaaa";
  const quiet = importPlan({
    agents: [],
    rooms: [
      {
        hopCount: 0,
        leadId,
        members: [],
        messages: [],
        name: "quiet",
        paused: false,
        roomId,
        topic: "",
      },
      {
        hopCount: 1,
        leadId,
        members: [],
        messages: [legacyMessage(["Sam"])],
        name: "paused",
        paused: true,
        roomId: "room_bbbbbbbbbbbbbbbbbbbbbbbb",
        topic: "",
      },
    ],
  });
  expect(quiet.rooms[0]?.events.map((event) => event._tag)).toEqual([
    "RoomOpened",
  ]);
  const paused = quiet.rooms[1]?.events ?? [];
  expect(paused.map((event) => event._tag)).toEqual([
    "RoomOpened",
    "MessagePosted",
    "RoomPaused",
  ]);
  expect(epochMillis(DateTime.makeUnsafe(0))).toBe(0);
});

test("room decisions reject the closed room and the missing member", () => {
  const closed = initialRoom;
  expect(
    tagOf(
      decideInvite(closed, { actorAdmin: true, actorId: leadId, member: sam })
    )
  ).toBe("RoomMissing");
  expect(tagOf(decideJoin(closed, { agentId: samId }))).toBe("RoomMissing");
  expect(tagOf(decideLeave(closed, { agentId: leadId }))).toBe("RoomMissing");
  expect(
    tagOf(
      decidePost(
        closed,
        {
          authorId: leadId,
          authorKind: "agent",
          authorName: "Lead",
          body: "hi",
          explicitMentions: [],
          replyTo: null,
          threadRoot: null,
        },
        1
      )
    )
  ).toBe("RoomMissing");
  expect(
    tagOf(
      decideEdit(closed, {
        actorId: leadId,
        authorKind: "agent",
        body: "x",
        explicitMentions: [],
        seq: 1,
      })
    )
  ).toBe("RoomMissing");
  expect(
    tagOf(decideRedact(closed, { actorAdmin: false, actorId: leadId, seq: 1 }))
  ).toBe("RoomMissing");
  expect(
    tagOf(decideReact(closed, { actorId: leadId, emoji: "ok", seq: 1 }))
  ).toBe("RoomMissing");
  expect(tagOf(decideRead(closed, { actorId: leadId, seq: 1 }))).toBe(
    "RoomMissing"
  );
  expect(
    tagOf(
      decideInvite(openRoom, {
        actorAdmin: false,
        actorId: samId,
        member: human,
      })
    )
  ).toBe("NotMember");
  expect(
    tagOf(
      decideJoin(openRoom, {
        agentId: agent("agent_ffffffffffffffffffffffff"),
      })
    )
  ).toBe("NotInvited");
  const joined = decideJoin(openRoom, { agentId: samId });
  expect(joined).toEqual([expect.objectContaining({ _tag: "MemberJoined" })]);
  const again = {
    ...openRoom,
    members: [lead, { ...sam, joined: true }, human],
  };
  expect(decideJoin(again, { agentId: samId })).toEqual([]);
  expect(tagOf(decideLeave(openRoom, { agentId: samId }))).toBe("NotMember");
  const left = decideLeave(again, { agentId: humanId });
  expect(left).toEqual([expect.objectContaining({ _tag: "MemberLeft" })]);
  expect(
    tagOf(decideLeave({ ...openRoom, members: [lead] }, { agentId: leadId }))
  ).toBe("OnlyMember");
  const invited = decideInvite(openRoom, {
    actorAdmin: true,
    actorId: samId,
    member: member(
      agent("agent_eeeeeeeeeeeeeeeeeeeeeeee"),
      "Eve",
      "agent",
      "member",
      false
    ),
  });
  expect(invited).toEqual([expect.objectContaining({ _tag: "MemberInvited" })]);
  expect(
    decideInvite(openRoom, { actorAdmin: true, actorId: samId, member: sam })
  ).toEqual([]);
});

test("posts keep the mention and thread rules", () => {
  const live = {
    ...openRoom,
    members: [lead, { ...sam, joined: true }, human],
  };
  const posted = decidePost(
    live,
    {
      authorId: leadId,
      authorKind: "agent",
      authorName: "Lead",
      body: "hi @Sam",
      explicitMentions: [],
      replyTo: null,
      threadRoot: null,
    },
    5
  );
  expect(posted).toEqual([expect.objectContaining({ _tag: "MessagePosted" })]);
  const missingThread = decidePost(
    live,
    {
      authorId: leadId,
      authorKind: "agent",
      authorName: "Lead",
      body: "hi @Sam",
      explicitMentions: [],
      replyTo: 9,
      threadRoot: null,
    },
    5
  );
  expect(tagOf(missingThread)).toBe("MessageNotFound");
  const threaded = { ...live, messages: [message(1, leadId, "hi")] };
  const reply = decidePost(
    threaded,
    {
      authorId: leadId,
      authorKind: "agent",
      authorName: "Lead",
      body: "reply @Sam",
      explicitMentions: [],
      replyTo: 1,
      threadRoot: null,
    },
    5
  );
  expect(reply).toEqual([
    expect.objectContaining({
      message: expect.objectContaining({ replyTo: 1, threadRoot: 1 }),
    }),
  ]);
  expect(
    tagOf(
      decidePost(
        threaded,
        {
          authorId: leadId,
          authorKind: "agent",
          authorName: "Lead",
          body: "root @Sam",
          explicitMentions: [],
          replyTo: null,
          threadRoot: 9,
        },
        5
      )
    )
  ).toBe("MessageNotFound");
});
