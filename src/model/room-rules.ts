import { DateTime } from "effect";
import type { AgentId } from "../domain/ids.ts";
import { systemAgentId } from "../domain/ids.ts";
import { clampCursor } from "../domain/wake-cursor.ts";
import { pauseNotice, planPost } from "../domain/wake-policy.ts";
import { inviteAllowed, invitedMember, nextLead } from "./membership.ts";
import {
  MentionRequired,
  MessageNotFound,
  NotAuthor,
  NotInvited,
  NotMember,
  OnlyMember,
  RoomMissing,
  SelfMentionOnly,
  UnknownMention,
} from "./rejections.ts";
import type { MemberState, MessageState, RoomState } from "./room-shape.ts";
import {
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
  RoomPaused,
  RoomResumed,
  WakeDelivered,
  WakeExpired,
} from "./room-shape.ts";

const joinedMember = (state: RoomState, agentId: AgentId) =>
  state.members.find((member) => member.agentId === agentId && member.joined);

const messageAt = (state: RoomState, seq: number) =>
  state.messages.find((message) => message.seq === seq);

const placedThread = (
  messages: readonly MessageState[],
  replyTo: number | null,
  threadRoot: number | null
) => {
  const found = (seq: number) =>
    messages.find((message) => message.seq === seq);
  if (replyTo !== null && found(replyTo) === undefined) {
    return { missing: replyTo };
  }
  const reply = replyTo === null ? undefined : found(replyTo);
  const root =
    replyTo === null
      ? threadRoot
      : (threadRoot ?? reply?.threadRoot ?? replyTo);
  if (root !== null && found(root) === undefined) {
    return { missing: root };
  }
  return { replyTo, threadRoot: root };
};

const mentionRejection = (
  plan: ReturnType<typeof planPost>
): MentionRequired | UnknownMention | SelfMentionOnly | undefined => {
  if (plan._tag === "RejectUntagged") {
    return new MentionRequired();
  }
  if (plan._tag === "UnknownMention") {
    return new UnknownMention({ token: plan.token });
  }
  if (plan._tag === "SelfMentionOnly") {
    return new SelfMentionOnly();
  }
  return undefined;
};

const wakeMembers = (members: readonly MemberState[]) =>
  members
    .filter((member) => member.joined)
    .map((member) => ({
      agentId: member.agentId,
      displayName: member.displayName,
      kind: member.kind,
    }));

const postedMessage = (
  input: {
    readonly authorId: AgentId;
    readonly authorKind: MessageState["authorKind"];
    readonly authorName: string;
    readonly body: string;
    readonly createdAt: number;
    readonly replyTo: number | null;
    readonly threadRoot: number | null;
  },
  seq: number,
  mentions: readonly string[]
): MessageState => ({
  authorId: input.authorId,
  authorKind: input.authorKind,
  authorName: input.authorName,
  body: input.body,
  createdAt: input.createdAt,
  mentions: [...mentions],
  reactions: [],
  redacted: false,
  replyTo: input.replyTo,
  seq,
  threadRoot: input.threadRoot,
});

export const decideInvite = (
  state: RoomState,
  command: {
    readonly actorAdmin: boolean;
    readonly actorId: AgentId;
    readonly member: MemberState;
  }
) => {
  if (!state.open) {
    return new RoomMissing();
  }
  const actor = joinedMember(state, command.actorId);
  if (!inviteAllowed(actor !== undefined, command.actorAdmin)) {
    return new NotMember();
  }
  const present = state.members.some(
    (member) => member.agentId === command.member.agentId
  );
  return present ? [] : [new MemberInvited({ member: command.member })];
};

export const decideJoin = (
  state: RoomState,
  command: { readonly agentId: AgentId }
) => {
  if (!state.open) {
    return new RoomMissing();
  }
  const member = state.members.find((item) => item.agentId === command.agentId);
  if (!invitedMember(member)) {
    return new NotInvited();
  }
  return member.joined ? [] : [new MemberJoined({ agentId: command.agentId })];
};

export const decideLeave = (
  state: RoomState,
  command: { readonly agentId: AgentId }
) => {
  if (!state.open) {
    return new RoomMissing();
  }
  const member = joinedMember(state, command.agentId);
  if (member === undefined) {
    return new NotMember();
  }
  const remaining = state.members.filter(
    (item) => item.agentId !== member.agentId && item.joined
  );
  const next = nextLead(member.role, remaining);
  if (member.role === "lead" && next === undefined) {
    return new OnlyMember();
  }
  const left = new MemberLeft({ agentId: member.agentId });
  return next === undefined
    ? [left]
    : [left, new LeadTransferred({ agentId: next.agentId })];
};

const isAccepted = (plan: {
  readonly _tag: string;
}): plan is {
  readonly _tag: "Accept";
  readonly notifyHuman: boolean;
  readonly paused: boolean;
  readonly resetHops: boolean;
  readonly storedMentions: readonly string[];
  readonly targets: readonly AgentId[];
} => plan._tag === "Accept";

const postPlan = (
  state: RoomState,
  command: {
    readonly authorId: AgentId;
    readonly authorKind: MessageState["authorKind"];
    readonly body: string;
    readonly explicitMentions: readonly string[];
  }
) => {
  const plan = planPost({
    authorId: command.authorId,
    authorKind: command.authorKind,
    body: command.body,
    explicitMentions: command.explicitMentions,
    hopCount: state.hopCount,
    members: wakeMembers(state.members),
    paused: state.paused,
  });
  const rejected = mentionRejection(plan);
  if (rejected !== undefined) {
    return rejected;
  }
  return plan._tag === "Accept" ? plan : new MentionRequired();
};

export const decidePost = (
  state: RoomState,
  command: {
    readonly authorId: AgentId;
    readonly authorKind: MessageState["authorKind"];
    readonly authorName: string;
    readonly body: string;
    readonly explicitMentions: readonly string[];
    readonly replyTo: number | null;
    readonly threadRoot: number | null;
  },
  now: number
) => {
  if (!state.open) {
    return new RoomMissing();
  }
  const author = joinedMember(state, command.authorId);
  if (author === undefined) {
    return new NotMember();
  }
  const placed = placedThread(
    state.messages,
    command.replyTo,
    command.threadRoot
  );
  if ("missing" in placed) {
    return new MessageNotFound();
  }
  const plan = postPlan(state, command);
  if (!isAccepted(plan)) {
    return plan;
  }
  const seq = state.messages.length + 1;
  const events: Array<
    MessagePosted | PauseNoticePosted | RoomPaused | RoomResumed
  > = [];
  const message = postedMessage(
    { ...command, createdAt: now, ...placed },
    seq,
    plan.storedMentions
  );
  events.push(new MessagePosted({ message, targets: [...plan.targets] }));
  if (plan.notifyHuman) {
    events.push(
      new PauseNoticePosted({
        message: postedMessage(
          {
            authorId: systemAgentId,
            authorKind: "agent",
            authorName: "room",
            body: pauseNotice,
            createdAt: now,
            replyTo: null,
            threadRoot: null,
          },
          seq + 1,
          ["human"]
        ),
      })
    );
  }
  if (plan.paused && !state.paused) {
    events.push(new RoomPaused());
  }
  if (plan.resetHops && state.paused) {
    events.push(new RoomResumed());
  }
  return events;
};

export const decideEdit = (
  state: RoomState,
  command: {
    readonly actorId: AgentId;
    readonly authorKind: MessageState["authorKind"];
    readonly body: string;
    readonly explicitMentions: readonly string[];
    readonly seq: number;
  }
) => {
  if (!state.open) {
    return new RoomMissing();
  }
  const actor = joinedMember(state, command.actorId);
  if (actor === undefined) {
    return new NotMember();
  }
  const message = messageAt(state, command.seq);
  if (message === undefined) {
    return new MessageNotFound();
  }
  if (message.authorId !== command.actorId) {
    return new NotAuthor();
  }
  const plan = postPlan(state, {
    authorId: command.actorId,
    authorKind: command.authorKind,
    body: command.body,
    explicitMentions: command.explicitMentions,
  });
  if (!isAccepted(plan)) {
    return plan;
  }
  return [
    new MessageEdited({
      body: command.body,
      mentions: [...plan.storedMentions],
      seq: command.seq,
    }),
  ];
};

export const decideRedact = (
  state: RoomState,
  command: {
    readonly actorAdmin: boolean;
    readonly actorId: AgentId;
    readonly seq: number;
  }
) => {
  if (!state.open) {
    return new RoomMissing();
  }
  const actor = joinedMember(state, command.actorId);
  if (actor === undefined && !command.actorAdmin) {
    return new NotMember();
  }
  const message = messageAt(state, command.seq);
  if (message === undefined) {
    return new MessageNotFound();
  }
  if (message.authorId !== command.actorId && !command.actorAdmin) {
    return new NotAuthor();
  }
  return [new MessageRedacted({ seq: command.seq })];
};

export const decideReact = (
  state: RoomState,
  command: {
    readonly actorId: AgentId;
    readonly emoji: string;
    readonly seq: number;
  }
) => {
  if (!state.open) {
    return new RoomMissing();
  }
  if (joinedMember(state, command.actorId) === undefined) {
    return new NotMember();
  }
  if (messageAt(state, command.seq) === undefined) {
    return new MessageNotFound();
  }
  const message = messageAt(state, command.seq);
  const added =
    message?.reactions.some(
      (reaction) =>
        reaction.agentId === command.actorId && reaction.emoji === command.emoji
    ) !== true;
  return [
    new MessageReacted({
      added,
      agentId: command.actorId,
      emoji: command.emoji,
      seq: command.seq,
    }),
  ];
};

export const decideRead = (
  state: RoomState,
  command: { readonly actorId: AgentId; readonly seq: number }
) => {
  if (!state.open) {
    return new RoomMissing();
  }
  const member = joinedMember(state, command.actorId);
  if (member === undefined) {
    return new NotMember();
  }
  const latest = state.messages.at(-1)?.seq ?? 0;
  const seq = clampCursor(member.lastReadSeq, command.seq, latest);
  return seq === member.lastReadSeq
    ? []
    : [new ReadAdvanced({ agentId: command.actorId, seq })];
};

export const decideRecord = (state: RoomState, id: string) =>
  state.deliveries.some((delivery) => delivery.id === id)
    ? []
    : [new WakeDelivered({ id })];

export const decideExpire = (state: RoomState, id: string) =>
  state.deliveries.some((delivery) => delivery.id === id)
    ? []
    : [new WakeExpired({ id })];

export const epochMillis = (now: DateTime.Utc) => DateTime.toEpochMillis(now);
