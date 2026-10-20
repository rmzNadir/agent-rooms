import { View } from "alchemy/Domain";
import { Schema } from "effect";
import { AgentId } from "../domain/ids.ts";
import { renderTranscript } from "../domain/transcript.ts";
import { Room } from "./room.ts";
import { MessageState } from "./room-shape.ts";

const TranscriptState = Schema.Struct({
  messages: Schema.Array(MessageState),
  roomName: Schema.String,
});
type TranscriptState = typeof TranscriptState.Type;
interface Posted {
  readonly message: MessageState;
}
interface Edited {
  readonly body: string;
  readonly mentions: readonly string[];
  readonly seq: number;
}

interface UnreadState {
  readonly latestSeq: number;
  readonly reads: readonly {
    readonly agentId: AgentId;
    readonly lastReadSeq: number;
  }[];
}
interface SearchState {
  readonly entries: readonly {
    readonly authorName: string;
    readonly body: string;
    readonly redacted: boolean;
    readonly seq: number;
  }[];
}

const UnreadState = Schema.Struct({
  latestSeq: Schema.Number,
  reads: Schema.Array(
    Schema.Struct({ agentId: AgentId, lastReadSeq: Schema.Number })
  ),
});

const SearchState = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      authorName: Schema.String,
      body: Schema.String,
      redacted: Schema.Boolean,
      seq: Schema.Number,
    })
  ),
});

const copyMessage = (
  message: MessageState,
  body: string,
  mentions: readonly string[],
  redacted: boolean
): MessageState => ({
  authorId: message.authorId,
  authorKind: message.authorKind,
  authorName: message.authorName,
  body,
  createdAt: message.createdAt,
  mentions,
  reactions: message.reactions,
  redacted,
  replyTo: message.replyTo,
  seq: message.seq,
  threadRoot: message.threadRoot,
});

const appendMessage = (state: TranscriptState, message: MessageState) => ({
  messages: [...state.messages, message],
  roomName: state.roomName,
});

export class Transcript extends View("Transcript", {
  computed: {
    markdown: (state: TranscriptState) =>
      renderTranscript({
        format: "markdown",
        messages: state.messages.map((message) => ({
          authorId: message.authorId,
          authorKind: message.authorKind,
          authorName: message.authorName,
          body: message.body,
          createdAt: message.createdAt,
          editedAt: null,
          id: String(message.seq),
          mentions: message.mentions,
          reactions: message.reactions,
          redacted: message.redacted,
          replyTo: message.replyTo,
          seq: message.seq,
          threadRoot: message.threadRoot,
        })),
        roomName: state.roomName,
      }),
  },
  evolve: {
    MessageEdited: (state: TranscriptState, event: Edited) => ({
      messages: state.messages.map((message) =>
        message.seq === event.seq
          ? copyMessage(message, event.body, event.mentions, message.redacted)
          : message
      ),
      roomName: state.roomName,
    }),
    MessagePosted: (state: TranscriptState, event: Posted) =>
      appendMessage(state, event.message),
    MessageRedacted: (
      state: TranscriptState,
      event: { readonly seq: number }
    ) => ({
      messages: state.messages.map((message) =>
        message.seq === event.seq
          ? copyMessage(message, "[redacted]", [], true)
          : message
      ),
      roomName: state.roomName,
    }),
    PauseNoticePosted: (state: TranscriptState, event: Posted) =>
      appendMessage(state, event.message),
    RoomOpened: (state: TranscriptState, event: { readonly name: string }) => ({
      messages: state.messages,
      roomName: event.name,
    }),
  },
  from: [Room],
  initial: { messages: [], roomName: "" },
  key: Room,
  state: TranscriptState,
}) {}

export class Unread extends View("Unread", {
  evolve: {
    MessagePosted: (state: UnreadState, event: Posted) => ({
      latestSeq: event.message.seq,
      reads: state.reads,
    }),
    PauseNoticePosted: (state: UnreadState, event: Posted) => ({
      latestSeq: event.message.seq,
      reads: state.reads,
    }),
    ReadAdvanced: (
      state: UnreadState,
      event: { readonly agentId: AgentId; readonly seq: number }
    ) => ({
      latestSeq: state.latestSeq,
      reads: [
        ...state.reads.filter((read) => read.agentId !== event.agentId),
        { agentId: event.agentId, lastReadSeq: event.seq },
      ],
    }),
  },
  from: [Room],
  initial: { latestSeq: 0, reads: [] },
  key: Room,
  state: UnreadState,
}) {}

const searchRow = (message: MessageState) => ({
  authorName: message.authorName,
  body: message.body,
  redacted: false,
  seq: message.seq,
});

const addSearch = (state: SearchState, message: MessageState) => ({
  entries: [...state.entries, searchRow(message)],
});

export class SearchIndex extends View("SearchIndex", {
  evolve: {
    MessageEdited: (state: SearchState, event: Edited) => ({
      entries: state.entries.map((entry) =>
        entry.seq === event.seq
          ? {
              authorName: entry.authorName,
              body: event.body,
              redacted: entry.redacted,
              seq: entry.seq,
            }
          : entry
      ),
    }),
    MessagePosted: (state: SearchState, event: Posted) =>
      addSearch(state, event.message),
    MessageRedacted: (state: SearchState, event: { readonly seq: number }) => ({
      entries: state.entries.map((entry) =>
        entry.seq === event.seq
          ? {
              authorName: entry.authorName,
              body: "[redacted]",
              redacted: true,
              seq: entry.seq,
            }
          : entry
      ),
    }),
    PauseNoticePosted: (state: SearchState, event: Posted) =>
      addSearch(state, event.message),
  },
  from: [Room],
  initial: { entries: [] },
  key: Room,
  state: SearchState,
}) {}
