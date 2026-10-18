import { DurableObjectState } from "alchemy/Cloudflare";
import { Effect, Option } from "effect";
import {
  MentionRequired,
  MessageNotFound,
  SelfMentionOnly,
  UnknownMention,
} from "../domain/errors.ts";
import { type RequestId, type RoomId, systemAgentId } from "../domain/ids.ts";
import { MessagePage, type MessageView } from "../domain/message.ts";
import {
  pauseNotice,
  planPost,
  type WakeMember,
} from "../domain/wake-policy.ts";
import type { PostPayload } from "./room-http-api.ts";
import {
  joinedMember,
  loadFlags,
  loadMembers,
  requireJoined,
} from "./room-members.ts";
import { insertMessage, messageBySeq } from "./room-messages.ts";
import {
  invalid,
  type MemberRow,
  notMember,
  persist,
  roomMissing,
  roomQuery,
} from "./room-sql.ts";

const missingMessage = (
  requestId: RequestId,
  roomId: RoomId,
  seq: number,
  label: string
) =>
  new MessageNotFound({
    code: "MessageNotFound",
    details: { roomId, seq },
    message: `${label} ${seq} was not found in room ${roomId}.`,
    operation: "message.read",
    requestId,
    retryable: false,
  });

const placeThread = (
  requestId: RequestId,
  roomId: RoomId,
  replyTo: number | null,
  threadRoot: number | null
) =>
  Effect.gen(function* () {
    let root = threadRoot;
    if (replyTo !== null) {
      const target = yield* messageBySeq(requestId, replyTo);
      if (Option.isNone(target)) {
        return yield* missingMessage(requestId, roomId, replyTo, "Message");
      }
      if (root === null) {
        root = target.value.threadRoot ?? target.value.seq;
      }
    }
    if (root !== null) {
      const found = yield* messageBySeq(requestId, root);
      if (Option.isNone(found)) {
        return yield* missingMessage(requestId, roomId, root, "Thread");
      }
    }
    return { replyTo, threadRoot: root };
  });

const rejectPlan = (
  plan:
    | { readonly _tag: "RejectUntagged" }
    | { readonly _tag: "UnknownMention"; readonly token: string }
    | { readonly _tag: "SelfMentionOnly" },
  roomId: RoomId,
  requestId: RequestId
) => {
  if (plan._tag === "RejectUntagged") {
    return new MentionRequired({
      code: "MentionRequired",
      details: { roomId },
      message: `Message in room ${roomId} was not posted. Agents must @mention a member, @all, or @human.`,
      operation: "post_message",
      requestId,
      retryable: false,
    });
  }
  if (plan._tag === "UnknownMention") {
    return new UnknownMention({
      code: "UnknownMention",
      details: { roomId, token: plan.token },
      message: `@${plan.token} is not a member of room ${roomId}. Use a display name, @all, or @human.`,
      operation: "post_message",
      requestId,
      retryable: false,
    });
  }
  return new SelfMentionOnly({
    code: "SelfMentionOnly",
    details: { roomId },
    message: `Message in room ${roomId} only mentioned you. Mention someone else; posts do not wake their author.`,
    operation: "post_message",
    requestId,
    retryable: false,
  });
};

const wakeMembersOf = (members: readonly MemberRow[]): WakeMember[] =>
  members
    .filter((item) => item.joined)
    .map((item) => ({
      agentId: item.agentId,
      displayName: item.displayName,
      kind: item.kind,
    }));

const fanout = <EnqueueError, EnqueueEnv>(
  enqueue: (
    requestId: RequestId,
    member: MemberRow,
    messageId: string,
    messageSeq: number
  ) => Effect.Effect<void, EnqueueError, EnqueueEnv>,
  requestId: RequestId,
  members: readonly MemberRow[],
  targets: readonly string[],
  messageId: string,
  endSeq: number
) =>
  Effect.gen(function* () {
    for (const target of targets) {
      const targetMember = members.find(
        (item) => item.agentId === target && item.joined
      );
      if (targetMember !== undefined) {
        yield* enqueue(requestId, targetMember, messageId, endSeq);
      }
    }
  });

const commitPost = <EnqueueError, EnqueueEnv>(
  enqueue: (
    requestId: RequestId,
    member: MemberRow,
    messageId: string,
    messageSeq: number
  ) => Effect.Effect<void, EnqueueError, EnqueueEnv>,
  payload: PostPayload,
  placed: {
    readonly replyTo: number | null;
    readonly threadRoot: number | null;
  }
) =>
  Effect.gen(function* () {
    const flags = yield* loadFlags(payload.requestId);
    if (Option.isNone(flags)) {
      return { _tag: "Missing" as const };
    }
    const members = yield* loadMembers(payload.requestId);
    const member = joinedMember(payload.actor, members);
    if (member === undefined) {
      return { _tag: "Gone" as const };
    }
    const plan = planPost({
      authorId: member.agentId,
      authorKind: member.kind,
      body: payload.body,
      explicitMentions: payload.mentions,
      hopCount: flags.value.hopCount,
      members: wakeMembersOf(members),
      paused: flags.value.paused,
    });
    if (plan._tag !== "Accept") {
      return { _tag: "Rejected" as const, plan };
    }
    yield* roomQuery(
      payload.requestId,
      "UPDATE room_flags SET hop_count = ?, paused = ? WHERE id = 1",
      plan.nextHopCount,
      plan.paused ? 1 : 0
    );
    const message = yield* insertMessage({
      authorId: member.agentId,
      authorKind: member.kind,
      authorName: member.displayName,
      body: payload.body,
      mentions: plan.storedMentions,
      replyTo: placed.replyTo,
      requestId: payload.requestId,
      threadRoot: placed.threadRoot,
    });
    const notice = plan.notifyHuman
      ? yield* insertMessage({
          authorId: systemAgentId,
          authorKind: "agent",
          authorName: "room",
          body: pauseNotice,
          mentions: ["human"],
          replyTo: null,
          requestId: payload.requestId,
          threadRoot: null,
        })
      : undefined;
    const endSeq = notice === undefined ? message.seq : notice.seq;
    yield* fanout(
      enqueue,
      payload.requestId,
      members,
      plan.targets,
      message.id,
      endSeq
    );
    return { _tag: "Stored" as const, message, notice };
  });

const publishStored = <PublishError, PublishEnv>(
  publish: (
    message: MessageView
  ) => Effect.Effect<void, PublishError, PublishEnv>,
  message: MessageView,
  notice: MessageView | undefined
) =>
  Effect.gen(function* () {
    yield* publish(message);
    if (notice !== undefined) {
      yield* publish(notice);
    }
    const messages = notice === undefined ? [message] : [message, notice];
    const last = messages.at(-1);
    return new MessagePage({
      messages,
      nextCursor: last === undefined ? null : last.seq,
    });
  });

export const postMessage = <EnqueueError, EnqueueEnv, PublishError, PublishEnv>(
  enqueue: (
    requestId: RequestId,
    member: MemberRow,
    messageId: string,
    messageSeq: number
  ) => Effect.Effect<void, EnqueueError, EnqueueEnv>,
  publish: (
    message: MessageView
  ) => Effect.Effect<void, PublishError, PublishEnv>
) =>
  Effect.fn("RoomServer.postMessage")(function* (payload: PostPayload) {
    if (payload.body.trim().length === 0 || payload.body.length > 8000) {
      return yield* invalid(
        payload.requestId,
        "post_message",
        "body",
        "must be 1 to 8000 characters"
      );
    }
    const { id } = yield* requireJoined(payload.actor, payload.requestId);
    const placed = yield* placeThread(
      payload.requestId,
      id,
      payload.replyTo,
      payload.threadRoot
    );
    const current = yield* DurableObjectState;
    const stored = yield* current.storage
      .transaction(commitPost(enqueue, payload, placed))
      .pipe(
        Effect.catchTag("DurableObjectStorageError", () =>
          Effect.fail(persist(payload.requestId, "post_message"))
        )
      );
    if (stored._tag === "Missing") {
      return yield* roomMissing(id, payload.requestId);
    }
    if (stored._tag === "Gone") {
      return yield* notMember(id, payload.requestId);
    }
    if (stored._tag === "Rejected") {
      return yield* rejectPlan(stored.plan, id, payload.requestId);
    }
    return yield* publishStored(publish, stored.message, stored.notice);
  });
