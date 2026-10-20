import { MessagePage, MessageView, ThreadSummary } from "../domain/message.ts";
import type { MessageState } from "../model/room-shape.ts";
import { searchBodies } from "../model/search.ts";

const messageId = (seq: number) => `msg_${seq.toString(16).padStart(16, "0")}`;

export const toMessageView = (message: MessageState) =>
  new MessageView({
    authorId: message.authorId,
    authorKind: message.authorKind,
    authorName: message.authorName,
    body: message.body,
    createdAt: message.createdAt,
    editedAt: null,
    id: messageId(message.seq),
    mentions: [...message.mentions],
    reactions: message.reactions.map((reaction) => ({
      agentId: reaction.agentId,
      emoji: reaction.emoji,
    })),
    redacted: message.redacted,
    replyTo: message.replyTo,
    seq: message.seq,
    threadRoot: message.threadRoot,
  });

const inThread = (message: MessageState, thread: number | null) =>
  thread === null || message.threadRoot === thread || message.seq === thread;

export const commandMessages = (
  events: readonly {
    readonly _tag: string;
    readonly message?: MessageState;
  }[]
) => {
  const messages: MessageState[] = [];
  for (const event of events) {
    if (event.message === undefined) {
      continue;
    }
    if (event._tag === "MessagePosted" || event._tag === "PauseNoticePosted") {
      messages.push(event.message);
    }
  }
  return messages;
};

export const messagePage = (
  messages: readonly MessageState[],
  since: number,
  limit: number,
  thread: number | null
) => {
  const selected = messages
    .filter((message) => message.seq > since && inThread(message, thread))
    .slice(0, limit);
  const last = selected.at(-1);
  return new MessagePage({
    messages: selected.map(toMessageView),
    nextCursor: last === undefined ? null : last.seq,
  });
};

export const readCursor = (
  member: { readonly lastReadSeq: number } | undefined,
  fallback: number
) => (member === undefined ? fallback : member.lastReadSeq);

export const tailSeq = (messages: readonly { readonly seq: number }[]) => {
  const last = messages.at(-1);
  return last === undefined ? 0 : last.seq;
};

export const threadList = (
  messages: readonly MessageState[],
  limit: number
) => {
  const roots = messages.filter((message) => message.threadRoot === null);
  const summaries = roots.map((root) => {
    const replies = messages.filter(
      (message) => message.threadRoot === root.seq
    );
    const last = replies.at(-1);
    return new ThreadSummary({
      lastSeq: last === undefined ? root.seq : last.seq,
      preview: root.body.slice(0, 180),
      replies: replies.length,
      rootSeq: root.seq,
    });
  });
  return summaries
    .sort((left, right) => (left.lastSeq < right.lastSeq ? 1 : -1))
    .slice(0, limit);
};

export const searchPage = (
  messages: readonly MessageState[],
  query: string,
  limit: number
) => {
  const found = searchBodies(
    messages.map((message) => ({
      authorName: message.authorName,
      body: message.body,
      redacted: message.redacted,
      seq: message.seq,
    })),
    query,
    limit
  );
  const selected = found.flatMap((entry) =>
    messages.filter((item) => item.seq === entry.seq)
  );
  const last = selected.at(-1);
  return new MessagePage({
    messages: selected.map(toMessageView),
    nextCursor: last === undefined ? null : last.seq,
  });
};

export const unreadCount = (
  messages: readonly MessageState[],
  lastReadSeq: number,
  agentId: string
) =>
  messages.filter(
    (message) => message.seq > lastReadSeq && message.authorId !== agentId
  ).length;
