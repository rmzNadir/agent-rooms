import { test } from "bun:test";
import { Story } from "alchemy/Domain/Story";
import { Effect, Schema } from "effect";
import { RoomId } from "../src/domain/ids.ts";
import { MentionRequired, OnlyMember } from "../src/model/rejections.ts";
import { Room } from "../src/model/room.ts";
import {
  EditMessage,
  InviteMember,
  JoinRoom,
  LeaveRoom,
  OpenRoom,
  PostMessage,
  ReactToMessage,
  RedactMessage,
} from "../src/model/room-commands.ts";
import {
  MemberInvited,
  MemberJoined,
  MessageEdited,
  MessagePosted,
  MessageReacted,
  MessageRedacted,
  RoomOpened,
  WakeDelivered,
} from "../src/model/room-shape.ts";
import { Rooms, RoomsHandlers } from "../src/model/rooms-model.ts";
import { TranscriptLine, TranscriptLog } from "../src/model/transcript-log.ts";
import { SearchIndex, Transcript, Unread } from "../src/model/views.ts";
import { Webhook } from "../src/model/wake.ts";
import { humanId, leadId, member, samId } from "./model-fixture.ts";

const roomId = Schema.decodeUnknownSync(RoomId)(
  "room_aaaaaaaaaaaaaaaaaaaaaaaa"
);

const story = Story.make(Rooms, {
  externalSystems: [Webhook],
  layer: RoomsHandlers,
});

const room = Room.ref(roomId);
const at = 1_767_225_600_000;

const posted = (
  body: string,
  authorId: typeof leadId,
  authorName: string,
  authorKind: "agent" | "human",
  seq: number,
  mentions: readonly string[],
  targets: readonly (typeof leadId)[]
) =>
  new MessagePosted({
    message: {
      authorId,
      authorKind,
      authorName,
      body,
      createdAt: at,
      mentions: [...mentions],
      reactions: [],
      redacted: false,
      replyTo: null,
      seq,
      threadRoot: null,
    },
    targets: [...targets],
  });

const run = (effect: Effect.Effect<void, never, never>) =>
  Effect.runPromise(effect);

test("opening, inviting, and a human post wake the agents", async () => {
  await run(
    story(
      Story.when(
        room,
        new OpenRoom({
          leadId,
          members: [
            member(leadId, "Lead", "agent", "lead"),
            member(humanId, "Ada", "human", "member"),
          ],
          name: "general",
          topic: "ship",
        })
      ),
      Story.then(
        room,
        new RoomOpened({
          leadId,
          members: [
            member(leadId, "Lead", "agent", "lead"),
            member(humanId, "Ada", "human", "member"),
          ],
          name: "general",
          topic: "ship",
        })
      ),
      Story.replied({ name: "general" }),
      Story.when(
        room,
        new InviteMember({
          actorAdmin: false,
          actorId: leadId,
          member: member(samId, "Sam", "agent", "member", false),
        })
      ),
      Story.then(
        room,
        new MemberInvited({
          member: member(samId, "Sam", "agent", "member", false),
        })
      ),
      Story.when(room, new JoinRoom({ agentId: samId })),
      Story.then(room, new MemberJoined({ agentId: samId })),
      Story.when(
        room,
        new PostMessage({
          authorId: humanId,
          authorKind: "human",
          authorName: "Ada",
          body: "hello",
          explicitMentions: [],
          replyTo: null,
          threadRoot: null,
        })
      ),
      Story.then(
        room,
        posted("hello", humanId, "Ada", "human", 1, ["all"], [leadId, samId])
      ),
      Story.view(Transcript, room, { roomName: "general" }),
      Story.expectCall(Webhook.deliver, { body: "hello", roomId }),
      Story.resolve(Webhook.deliver, { status: 200 }),
      Story.then(room, new WakeDelivered({ id: "1" })),
      Story.view(Unread, room, { latestSeq: 1 }),
      Story.clock("2026-01-01T00:00:26Z"),
      Story.then(room),
      Story.streamed(
        TranscriptLog,
        room,
        new TranscriptLine({ body: "hello", seq: 1 })
      )
    )
  );
});

const pair = [
  member(leadId, "Lead", "agent", "lead"),
  member(samId, "Sam", "agent", "member"),
];

const opened = (name: string) => [
  Story.when(room, new OpenRoom({ leadId, members: pair, name, topic: "" })),
  Story.then(room, new RoomOpened({ leadId, members: pair, name, topic: "" })),
];

const agentPost = (body: string, explicitMentions: readonly string[] = []) =>
  new PostMessage({
    authorId: leadId,
    authorKind: "agent",
    authorName: "Lead",
    body,
    explicitMentions,
    replyTo: null,
    threadRoot: null,
  });

const samPosted = (body: string) => [
  Story.when(room, agentPost(body)),
  Story.then(room, posted(body, leadId, "Lead", "agent", 1, ["Sam"], [samId])),
];

test("an untagged agent post is rejected and a named mention is delivered", async () => {
  await run(
    story(
      ...opened("general"),
      Story.when(room, agentPost("silent")),
      Story.rejected(new MentionRequired()),
      ...samPosted("hi @Sam"),
      Story.expectCall(Webhook.deliver, { body: "hi @Sam", roomId }),
      Story.resolve(Webhook.deliver, { status: 200 }),
      Story.then(room, new WakeDelivered({ id: "1" })),
      Story.view(SearchIndex, room, {
        entries: [
          { authorName: "Lead", body: "hi @Sam", redacted: false, seq: 1 },
        ],
      })
    )
  );
});

test("the last lead cannot leave, and a reaction does not wake", async () => {
  await run(
    story(
      Story.when(
        room,
        new OpenRoom({
          leadId,
          members: [member(leadId, "Lead", "agent", "lead")],
          name: "solo",
          topic: "",
        })
      ),
      Story.then(
        room,
        new RoomOpened({
          leadId,
          members: [member(leadId, "Lead", "agent", "lead")],
          name: "solo",
          topic: "",
        })
      ),
      Story.when(room, new LeaveRoom({ agentId: leadId })),
      Story.rejected(new OnlyMember()),
      Story.when(
        room,
        new PostMessage({
          authorId: leadId,
          authorKind: "agent",
          authorName: "Lead",
          body: "hi @human",
          explicitMentions: ["human"],
          replyTo: null,
          threadRoot: null,
        })
      ),
      Story.then(
        room,
        posted("hi @human", leadId, "Lead", "agent", 1, ["human"], [])
      ),
      Story.when(
        room,
        new ReactToMessage({ actorId: leadId, emoji: "ok", seq: 1 })
      ),
      Story.then(
        room,
        new MessageReacted({
          added: true,
          agentId: leadId,
          emoji: "ok",
          seq: 1,
        })
      )
    )
  );
});

test("edit and redact stay on the transcript and do not call the webhook", async () => {
  await run(
    story(
      ...opened("general"),
      ...samPosted("hi @Sam"),
      Story.expectCall(Webhook.deliver, { roomId }),
      Story.resolve(Webhook.deliver, { status: 200 }),
      Story.then(room, new WakeDelivered({ id: "1" })),
      Story.when(
        room,
        new EditMessage({
          actorId: leadId,
          authorKind: "agent",
          body: "edited @Sam",
          explicitMentions: [],
          seq: 1,
        })
      ),
      Story.then(
        room,
        new MessageEdited({ body: "edited @Sam", mentions: ["Sam"], seq: 1 })
      ),
      Story.when(
        room,
        new RedactMessage({ actorAdmin: false, actorId: leadId, seq: 1 })
      ),
      Story.then(room, new MessageRedacted({ seq: 1 })),
      Story.state(room, (state) => {
        const [message] = state.messages;
        if (message?.redacted !== true || message.body !== "[redacted]") {
          throw new Error("redact did not land");
        }
      })
    )
  );
});
