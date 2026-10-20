import { expect, test } from "bun:test";
import { Schema } from "effect";
import { AgentId } from "../src/domain/ids.ts";
import { MessageView } from "../src/domain/message.ts";
import { renderTranscript } from "../src/domain/transcript.ts";

const message = new MessageView({
  authorId: Schema.decodeUnknownSync(AgentId)("agent_aaaaaaaaaaaaaaaaaaaaaaaa"),
  authorKind: "agent",
  authorName: "ada",
  body: "hello @bob",
  createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  editedAt: null,
  id: "msg_1",
  mentions: ["bob"],
  reactions: [],
  redacted: false,
  replyTo: null,
  seq: 3,
  threadRoot: null,
});

const reply = new MessageView({
  authorId: message.authorId,
  authorKind: "agent",
  authorName: "ada",
  body: "reply",
  createdAt: message.createdAt,
  editedAt: null,
  id: "msg_2",
  mentions: [],
  reactions: [],
  redacted: false,
  replyTo: 3,
  seq: 4,
  threadRoot: 3,
});

const at = "2026-01-02T03:04:05.000Z";

test("markdown transcript names the room, sequence, author, and thread", () => {
  expect(
    renderTranscript({
      format: "markdown",
      messages: [message, reply],
      roomName: "launch",
    })
  ).toBe(
    [
      "# launch",
      "",
      `## #3 @ada (${at})`,
      "",
      "hello @bob",
      "",
      `## #4 @ada (${at}) · thread 3`,
      "",
      "reply",
      "",
    ].join("\n")
  );
});

test("an unknown transcript format is empty", () => {
  expect(
    renderTranscript({ format: "text", messages: [], roomName: "launch" })
  ).toBe("");
});

test("json transcript keeps the sequence and mentions", () => {
  expect(
    renderTranscript({
      format: "json",
      messages: [message, reply],
      roomName: "launch",
    })
  ).toBe(
    JSON.stringify({
      messages: [
        {
          at,
          author: "ada",
          body: "hello @bob",
          kind: "agent",
          mentions: ["bob"],
          redacted: false,
          replyTo: null,
          seq: 3,
          threadRoot: null,
        },
        {
          at,
          author: "ada",
          body: "reply",
          kind: "agent",
          mentions: [],
          redacted: false,
          replyTo: 3,
          seq: 4,
          threadRoot: 3,
        },
      ],
      roomName: "launch",
    })
  );
});
