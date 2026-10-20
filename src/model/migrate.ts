import { Schema } from "effect";
import { MemberKind } from "../domain/actor.ts";
import { AgentId, RoomId } from "../domain/ids.ts";
import type { MemberState, MessageState } from "./room-shape.ts";
import { MessagePosted, RoomOpened, RoomPaused } from "./room-shape.ts";

const LegacyMemberSchema = Schema.Struct({
  agentId: Schema.String,
  displayName: Schema.String,
  joined: Schema.Boolean,
  kind: Schema.Literals(["agent", "human"]),
  lastReadSeq: Schema.Number,
  role: Schema.Literals(["lead", "member"]),
  webhookSecret: Schema.String,
  webhookUrl: Schema.String,
});

const LegacyMessageSchema = Schema.Struct({
  authorId: Schema.String,
  authorKind: Schema.Literals(["agent", "human"]),
  authorName: Schema.String,
  body: Schema.String,
  createdAt: Schema.Number,
  mentions: Schema.Array(Schema.String),
  reactions: Schema.optional(
    Schema.Array(
      Schema.Struct({ agentId: Schema.String, emoji: Schema.String })
    )
  ),
  redacted: Schema.Boolean,
  replyTo: Schema.NullOr(Schema.Number),
  seq: Schema.Number,
  threadRoot: Schema.NullOr(Schema.Number),
});

const LegacyAgentSchema = Schema.Struct({
  admin: Schema.optional(Schema.Boolean),
  agentId: Schema.String,
  displayName: Schema.String,
  kind: Schema.Literals(["agent", "human"]),
  tokenHash: Schema.String,
  webhookSecret: Schema.optional(Schema.String),
  webhookUrl: Schema.optional(Schema.String),
});

export const LegacyRoomSchema = Schema.Struct({
  hopCount: Schema.Number,
  leadId: Schema.String,
  members: Schema.Array(LegacyMemberSchema),
  messages: Schema.Array(LegacyMessageSchema),
  name: Schema.String,
  paused: Schema.Boolean,
  roomId: Schema.String,
  topic: Schema.String,
});
export type LegacyRoomInput = typeof LegacyRoomSchema.Type;

export const LegacyDirectorySchema = Schema.Struct({
  agents: Schema.Array(LegacyAgentSchema),
  rooms: Schema.Array(LegacyRoomSchema),
});

export const cutoverRule =
  "replay into the existing room and directory objects only when their event log is empty";

interface SecretCopy {
  readonly agentId: string;
  readonly webhookSecret: string;
  readonly webhookUrl: string;
}

interface LegacyMember {
  readonly agentId: string;
  readonly displayName: string;
  readonly joined: boolean;
  readonly kind: "agent" | "human";
  readonly lastReadSeq: number;
  readonly role: "lead" | "member";
  readonly webhookSecret: string;
  readonly webhookUrl: string;
}

interface LegacyMessage {
  readonly authorId: string;
  readonly authorKind: "agent" | "human";
  readonly authorName: string;
  readonly body: string;
  readonly createdAt: number;
  readonly mentions: readonly string[];
  readonly reactions?:
    | readonly {
        readonly agentId: string;
        readonly emoji: string;
      }[]
    | undefined;
  readonly redacted: boolean;
  readonly replyTo: number | null;
  readonly seq: number;
  readonly threadRoot: number | null;
}

interface LegacyRoom {
  readonly hopCount: number;
  readonly leadId: string;
  readonly members: readonly LegacyMember[];
  readonly messages: readonly LegacyMessage[];
  readonly name: string;
  readonly paused: boolean;
  readonly roomId: string;
  readonly topic: string;
}

export interface LegacyDirectory {
  readonly agents: readonly {
    readonly admin?: boolean | undefined;
    readonly agentId: string;
    readonly displayName: string;
    readonly kind: "agent" | "human";
    readonly tokenHash: string;
    readonly webhookSecret?: string | undefined;
    readonly webhookUrl?: string | undefined;
  }[];
  readonly rooms: readonly LegacyRoom[];
}

const memberState = (member: LegacyMember): MemberState => ({
  agentId: Schema.decodeUnknownSync(AgentId)(member.agentId),
  displayName: member.displayName,
  joined: member.joined,
  kind: Schema.decodeUnknownSync(MemberKind)(member.kind),
  lastReadSeq: member.lastReadSeq,
  role: member.role,
});

const messageState = (message: LegacyMessage): MessageState => ({
  authorId: Schema.decodeUnknownSync(AgentId)(message.authorId),
  authorKind: Schema.decodeUnknownSync(MemberKind)(message.authorKind),
  authorName: message.authorName,
  body: message.body,
  createdAt: message.createdAt,
  mentions: [...message.mentions],
  reactions:
    message.reactions === undefined
      ? []
      : message.reactions.map((reaction) => ({
          agentId: Schema.decodeUnknownSync(AgentId)(reaction.agentId),
          emoji: reaction.emoji,
        })),
  redacted: message.redacted,
  replyTo: message.replyTo,
  seq: message.seq,
  threadRoot: message.threadRoot,
});

export const plannedRoom = <Room>(rooms: readonly Room[]) => {
  const [planned] = rooms;
  if (planned === undefined) {
    throw new Error("The room import plan was empty.");
  }
  return planned;
};

export const importPlan = (directory: LegacyDirectory) => {
  const secrets: SecretCopy[] = [];
  const rooms = directory.rooms.map((room) => {
    for (const member of room.members) {
      secrets.push({
        agentId: member.agentId,
        webhookSecret: member.webhookSecret,
        webhookUrl: member.webhookUrl,
      });
    }
    const opened = new RoomOpened({
      hopCount: room.hopCount,
      leadId: Schema.decodeUnknownSync(AgentId)(room.leadId),
      members: room.members.map(memberState),
      name: room.name,
      topic: room.topic,
    });
    const messages = room.messages.map(
      (message) =>
        new MessagePosted({ message: messageState(message), targets: [] })
    );
    const paused = room.paused ? [new RoomPaused()] : [];
    return {
      events: [opened, ...messages, ...paused],
      hopCount: room.hopCount,
      roomId: Schema.decodeUnknownSync(RoomId)(room.roomId),
    };
  });
  const tokens = directory.agents.map((agent) => ({
    agentId: agent.agentId,
    tokenHash: agent.tokenHash,
  }));
  return { rooms, secrets, tokens };
};
