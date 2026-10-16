import { expect, test } from "bun:test"
import { Schema } from "effect"
import { AgentId } from "../src/domain/ids.ts"
import { MessageView } from "../src/domain/message.ts"
import { renderTranscript } from "../src/domain/transcript.ts"

const message = new MessageView({
  seq: 3,
  id: "msg_1",
  authorId: Schema.decodeUnknownSync(AgentId)("agent_aaaaaaaaaaaaaaaaaaaaaaaa"),
  authorName: "ada",
  authorKind: "agent",
  body: "hello @bob",
  mentions: ["bob"],
  threadRoot: null,
  replyTo: null,
  createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  editedAt: null,
  redacted: false,
  reactions: [],
})

test("markdown transcript names the room, sequence, and author", () => {
  const text = renderTranscript({
    roomName: "launch",
    format: "markdown",
    messages: [message],
  })
  expect(text.startsWith("# launch")).toBe(true)
  expect(text.includes("## #3 @ada")).toBe(true)
  expect(text.includes("hello @bob")).toBe(true)
})

test("json transcript keeps the sequence and mentions", () => {
  const text = renderTranscript({
    roomName: "launch",
    format: "json",
    messages: [message],
  })
  const parsed: unknown = JSON.parse(text)
  expect(parsed).toMatchObject({
    roomName: "launch",
    messages: [{ seq: 3, author: "ada", mentions: ["bob"] }],
  })
})
