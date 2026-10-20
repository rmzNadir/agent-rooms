import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { at } from "../boundary/external.ts";
import type { RoomId } from "../domain/ids.ts";
import { IdentityView, UnreadView } from "../domain/message.ts";
import { renderTranscript } from "../domain/transcript.ts";
import { MAX_WAIT_MS } from "../domain/wake-policy.ts";
import {
  EditMessage,
  InviteMember,
  JoinRoom,
  LeaveRoom,
  MarkRead,
  PostMessage,
  ReactToMessage,
  RedactMessage,
} from "../model/room-commands.ts";
import type { MemberState, MessageState } from "../model/room-shape.ts";
import type { IChat } from "./chat.ts";
import {
  audit,
  type ChatHost,
  contextFor,
  editVerb,
  memberView,
  missingAgent,
} from "./chat-support.ts";
import { bodyLimit, emojiOf, limitOf, queryOf, sinceOf } from "./limits.ts";
import {
  commandMessages,
  messagePage,
  readCursor,
  searchPage,
  tailSeq,
  threadList,
  toMessageView,
  unreadCount,
} from "./pages.ts";
import { Ack, MemberList, ThreadList, TranscriptResult } from "./records.ts";

const text = (body: string, status: number) =>
  HttpServerResponse.text(body, { status });

const publish = (host: ChatHost, roomId: RoomId, message: MessageState) =>
  host.sockets
    .publish(
      roomId,
      JSON.stringify({ message: toMessageView(message), type: "message" })
    )
    .pipe(Effect.ignore);

const messageAfter = (host: ChatHost, roomId: RoomId, seq: number) =>
  Effect.gen(function* () {
    const state = yield* host.roomState(roomId);
    const message = state.messages.find(
      (item) => item.seq === seq
    ) as MessageState;
    yield* publish(host, roomId, message);
    return toMessageView(message);
  });

const waitSlots = Array.from({ length: 63 }, () => 0);

const waitPage = (
  rooms: ChatHost["rooms"],
  roomId: RoomId,
  since: number,
  limit: number,
  deadline: number
): Effect.Effect<ReturnType<typeof messagePage>> =>
  Effect.gen(function* () {
    const state = yield* rooms.state(roomId);
    let page = messagePage(state.messages, since, limit, null);
    const ticks = Math.min(
      Math.ceil(Math.max(deadline - Date.now(), 0) / 400),
      waitSlots.length
    );
    for (const tick of waitSlots.slice(0, ticks)) {
      if (page.messages.length > tick) {
        return page;
      }
      yield* Effect.sleep("400 millis");
      const next = yield* rooms.state(roomId);
      page = messagePage(next.messages, since, limit, null);
    }
    return page;
  });

const openSocket = (
  host: ChatHost,
  roomId: RoomId,
  request: Parameters<ChatHost["sockets"]["open"]>[1]
) =>
  Effect.gen(function* () {
    const upgrade = at(request.headers, "upgrade");
    if (typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket") {
      return text("Open the room socket with a websocket upgrade.", 400);
    }
    const header = at(request.headers, "x-agent-rooms-agent");
    if (typeof header !== "string") {
      return text("Sign in before opening the room socket.", 401);
    }
    const state = yield* host.roomState(roomId);
    const joined = state.members.some(
      (member) => member.agentId === header && member.joined
    );
    if (!joined) {
      return text("Join the room before opening the socket.", 403);
    }
    return yield* host.sockets.open(roomId, request);
  });

export const roomMethods = (
  host: ChatHost
): Pick<
  IChat,
  | "editMessage"
  | "forward"
  | "getUnread"
  | "invite"
  | "join"
  | "leave"
  | "listThreads"
  | "markRead"
  | "members"
  | "postMessage"
  | "react"
  | "readMessages"
  | "readTranscript"
  | "redactMessage"
  | "searchMessages"
  | "waitForMessages"
  | "whoami"
> => ({
  editMessage: (actor, requestId, roomId, seq, body, mentions) =>
    Effect.gen(function* () {
      yield* bodyLimit(requestId, "edit_message", body);
      yield* host.settle(
        host.rooms.send(
          roomId,
          new EditMessage({
            actorId: actor.agentId,
            authorKind: actor.kind,
            body,
            explicitMentions: [...mentions],
            seq,
          })
        ),
        contextFor(requestId, roomId, seq, audit, editVerb)
      );
      return yield* messageAfter(host, roomId, seq);
    }),
  forward: (roomId, request, _requestId) => openSocket(host, roomId, request),
  getUnread: (actor, requestId, roomId) =>
    Effect.gen(function* () {
      const loaded = yield* host.requireRoom(actor, requestId, roomId);
      const lastReadSeq = readCursor(loaded.member, 0);
      const latestSeq = tailSeq(loaded.state.messages);
      return new UnreadView({
        lastReadSeq,
        latestSeq,
        roomId,
        unread: unreadCount(loaded.state.messages, lastReadSeq, actor.agentId),
      });
    }),
  invite: (actor, requestId, roomId, agentId) =>
    Effect.gen(function* () {
      const state = yield* host.agents();
      const record = state.agents.find((agent) => agent.agentId === agentId);
      if (record === undefined) {
        return yield* Effect.fail(missingAgent(requestId, agentId));
      }
      yield* host.settle(
        host.rooms.send(
          roomId,
          new InviteMember({
            actorAdmin: actor.admin,
            actorId: actor.agentId,
            member: {
              agentId: record.agentId,
              displayName: record.displayName,
              joined: false,
              kind: record.kind,
              lastReadSeq: 0,
              role: "member",
            },
          })
        ),
        contextFor(requestId, roomId, undefined, audit, editVerb, agentId)
      );
      const room = yield* host.roomState(roomId);
      const member = room.members.find(
        (item) => item.agentId === agentId
      ) as MemberState;
      return memberView(member);
    }),
  join: (actor, requestId, roomId) =>
    Effect.gen(function* () {
      yield* host.settle(
        host.rooms.send(roomId, new JoinRoom({ agentId: actor.agentId })),
        contextFor(requestId, roomId, undefined, audit, editVerb, actor.agentId)
      );
      const room = yield* host.roomState(roomId);
      const member = room.members.find(
        (item) => item.agentId === actor.agentId
      ) as MemberState;
      return memberView(member);
    }),
  leave: (actor, requestId, roomId) =>
    Effect.gen(function* () {
      yield* host.settle(
        host.rooms.send(roomId, new LeaveRoom({ agentId: actor.agentId })),
        contextFor(requestId, roomId, undefined, audit, editVerb)
      );
      yield* host.sockets.close(roomId, actor.agentId).pipe(Effect.ignore);
      return new Ack({ ok: true });
    }),
  listThreads: (actor, requestId, roomId, limit) =>
    Effect.gen(function* () {
      const bounded = yield* limitOf(requestId, "list_threads", limit);
      const loaded = yield* host.requireRoom(actor, requestId, roomId);
      return new ThreadList({
        threads: threadList(loaded.state.messages, bounded),
      });
    }),
  markRead: (actor, requestId, roomId, seq) =>
    Effect.gen(function* () {
      yield* host.settle(
        host.rooms.send(roomId, new MarkRead({ actorId: actor.agentId, seq })),
        contextFor(requestId, roomId, seq, audit, editVerb)
      );
      const state = yield* host.roomState(roomId);
      const member = state.members.find(
        (item) => item.agentId === actor.agentId
      ) as MemberState;
      const lastReadSeq = readCursor(member, seq);
      const latestSeq = tailSeq(state.messages);
      return new UnreadView({
        lastReadSeq,
        latestSeq,
        roomId,
        unread: unreadCount(state.messages, lastReadSeq, actor.agentId),
      });
    }),
  members: (actor, requestId, roomId) =>
    Effect.gen(function* () {
      const loaded = yield* host.requireRoom(actor, requestId, roomId);
      return new MemberList({ members: loaded.state.members.map(memberView) });
    }),
  postMessage: (input) =>
    Effect.gen(function* () {
      yield* bodyLimit(input.requestId, "post_message", input.body);
      const sent = yield* host.settle(
        host.rooms.send(
          input.roomId,
          new PostMessage({
            authorId: input.actor.agentId,
            authorKind: input.actor.kind,
            authorName: input.actor.displayName,
            body: input.body,
            explicitMentions: [...input.mentions],
            replyTo: input.replyTo,
            threadRoot: input.threadRoot,
          })
        ),
        contextFor(
          input.requestId,
          input.roomId,
          input.replyTo ?? input.threadRoot ?? undefined,
          audit,
          editVerb
        )
      );
      const fresh = commandMessages(sent.events);
      for (const message of fresh) {
        yield* publish(host, input.roomId, message);
      }
      return messagePage(fresh, 0, 200, null);
    }),
  react: (actor, requestId, roomId, seq, emoji) =>
    Effect.gen(function* () {
      yield* emojiOf(requestId, emoji);
      yield* host.settle(
        host.rooms.send(
          roomId,
          new ReactToMessage({ actorId: actor.agentId, emoji, seq })
        ),
        contextFor(requestId, roomId, seq, audit, editVerb)
      );
      return yield* messageAfter(host, roomId, seq);
    }),
  readMessages: (input) =>
    Effect.gen(function* () {
      const bounded = yield* limitOf(
        input.requestId,
        "read_messages",
        input.limit
      );
      yield* sinceOf(input.requestId, "read_messages", input.since);
      const loaded = yield* host.requireRoom(
        input.actor,
        input.requestId,
        input.roomId
      );
      const page = messagePage(
        loaded.state.messages,
        input.since,
        bounded,
        input.thread
      );
      const last = page.messages.at(-1);
      if (last !== undefined) {
        yield* host.rooms
          .send(
            input.roomId,
            new MarkRead({ actorId: input.actor.agentId, seq: last.seq })
          )
          .pipe(Effect.ignore);
      }
      return page;
    }),
  readTranscript: (input) =>
    Effect.gen(function* () {
      const bounded = yield* limitOf(
        input.requestId,
        "read_transcript",
        input.limit
      );
      const loaded = yield* host.requireRoom(
        input.actor,
        input.requestId,
        input.roomId
      );
      const page = messagePage(
        loaded.state.messages,
        input.since,
        bounded,
        input.thread
      );
      return new TranscriptResult({
        format: input.format,
        nextCursor: page.nextCursor,
        text: renderTranscript({
          format: input.format,
          messages: page.messages,
          roomName: loaded.state.name,
        }),
      });
    }),
  redactMessage: (actor, requestId, roomId, seq) =>
    Effect.gen(function* () {
      yield* host.settle(
        host.rooms.send(
          roomId,
          new RedactMessage({
            actorAdmin: actor.admin,
            actorId: actor.agentId,
            seq,
          })
        ),
        contextFor(requestId, roomId, seq, audit, "redact")
      );
      return yield* messageAfter(host, roomId, seq);
    }),
  searchMessages: (actor, requestId, roomId, query, limit) =>
    Effect.gen(function* () {
      const bounded = yield* limitOf(requestId, "search_messages", limit);
      const needle = yield* queryOf(requestId, query);
      const loaded = yield* host.requireRoom(actor, requestId, roomId);
      return searchPage(loaded.state.messages, needle, bounded);
    }),
  waitForMessages: (actor, requestId, roomId, since, limit, timeoutMs) =>
    Effect.gen(function* () {
      const bounded = yield* limitOf(requestId, "wait_for_messages", limit);
      yield* sinceOf(requestId, "wait_for_messages", since);
      yield* host.requireRoom(actor, requestId, roomId);
      const waited = Math.min(Math.max(timeoutMs, 0), MAX_WAIT_MS);
      return yield* waitPage(
        host.rooms,
        roomId,
        since,
        bounded,
        Date.now() + waited
      );
    }),
  whoami: (actor) =>
    new IdentityView({
      admin: actor.admin,
      agentId: actor.agentId,
      displayName: actor.displayName,
      kind: actor.kind,
    }),
});
