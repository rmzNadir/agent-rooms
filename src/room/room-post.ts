import { DurableObjectState } from "alchemy/Cloudflare";
import { Effect, Option } from "effect";
import {
  MentionRequired,
  MessageNotFound,
  SelfMentionOnly,
  UnknownMention,
} from "../domain/errors.ts";
import { type RequestId, systemAgentId } from "../domain/ids.ts";
import { MessagePage, type MessageView } from "../domain/message.ts";
import { planPost, type WakeMember } from "../domain/wake-policy.ts";
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
    let { threadRoot } = payload;
    const { replyTo } = payload;
    if (replyTo !== null) {
      const target = yield* messageBySeq(payload.requestId, replyTo);
      if (Option.isNone(target)) {
        return yield* new MessageNotFound({
          code: "MessageNotFound",
          details: { roomId: id, seq: replyTo },
          message: `Message ${replyTo} was not found in room ${id}.`,
          operation: "message.read",
          requestId: payload.requestId,
          retryable: false,
        });
      }
      if (threadRoot === null) {
        threadRoot = target.value.threadRoot ?? target.value.seq;
      }
    }
    if (threadRoot !== null) {
      const root = yield* messageBySeq(payload.requestId, threadRoot);
      if (Option.isNone(root)) {
        return yield* new MessageNotFound({
          code: "MessageNotFound",
          details: { roomId: id, seq: threadRoot },
          message: `Thread ${threadRoot} was not found in room ${id}.`,
          operation: "message.read",
          requestId: payload.requestId,
          retryable: false,
        });
      }
    }
    const current = yield* DurableObjectState;
    const stored = yield* current.storage
      .transaction(
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
          const wakeMembers: WakeMember[] = members
            .filter((item) => item.joined)
            .map((item) => ({
              agentId: item.agentId,
              displayName: item.displayName,
              kind: item.kind,
            }));
          const plan = planPost({
            authorId: member.agentId,
            authorKind: member.kind,
            body: payload.body,
            explicitMentions: payload.mentions,
            hopCount: flags.value.hopCount,
            members: wakeMembers,
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
            replyTo,
            requestId: payload.requestId,
            threadRoot,
          });
          let notice: MessageView | undefined;
          if (plan.notifyHuman) {
            notice = yield* insertMessage({
              authorId: systemAgentId,
              authorKind: "agent",
              authorName: "room",
              body: "@human Agent-to-agent wakes are paused after 20 hops with no human message. Post in this room to resume.",
              mentions: ["human"],
              replyTo: null,
              requestId: payload.requestId,
              threadRoot: null,
            });
          }
          const endSeq = notice === undefined ? message.seq : notice.seq;
          for (const target of plan.targets) {
            const targetMember = members.find(
              (item) => item.agentId === target && item.joined
            );
            if (targetMember !== undefined) {
              yield* enqueue(
                payload.requestId,
                targetMember,
                message.id,
                endSeq
              );
            }
          }
          return { _tag: "Stored" as const, message, notice };
        })
      )
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
      const { plan } = stored;
      if (plan._tag === "RejectUntagged") {
        return yield* new MentionRequired({
          code: "MentionRequired",
          details: { roomId: id },
          message: `Message in room ${id} was not posted. Agents must @mention a member, @all, or @human.`,
          operation: "post_message",
          requestId: payload.requestId,
          retryable: false,
        });
      }
      if (plan._tag === "UnknownMention") {
        return yield* new UnknownMention({
          code: "UnknownMention",
          details: { roomId: id, token: plan.token },
          message: `@${plan.token} is not a member of room ${id}. Use a display name, @all, or @human.`,
          operation: "post_message",
          requestId: payload.requestId,
          retryable: false,
        });
      }
      return yield* new SelfMentionOnly({
        code: "SelfMentionOnly",
        details: { roomId: id },
        message: `Message in room ${id} only mentioned you. Mention someone else; posts do not wake their author.`,
        operation: "post_message",
        requestId: payload.requestId,
        retryable: false,
      });
    }
    yield* publish(stored.message);
    if (stored.notice !== undefined) {
      yield* publish(stored.notice);
    }
    const messages =
      stored.notice === undefined
        ? [stored.message]
        : [stored.message, stored.notice];
    const last = messages.at(-1);
    return new MessagePage({
      messages,
      nextCursor: last === undefined ? null : last.seq,
    });
  });
