import type { MessageView } from "./message.ts"

const stamp = (millis: number) => new Date(millis).toISOString()

/**
 * Render a page of messages as markdown or JSON for `read_transcript`.
 * Redacted bodies are already replaced before this runs.
 */
export const renderTranscript = (input: {
  readonly roomName: string
  readonly format: "markdown" | "json"
  readonly messages: ReadonlyArray<MessageView>
}): string => {
  if (input.format === "json") {
    return JSON.stringify({
      roomName: input.roomName,
      messages: input.messages.map((message) => ({
        seq: message.seq,
        author: message.authorName,
        kind: message.authorKind,
        at: stamp(message.createdAt),
        body: message.body,
        mentions: message.mentions,
        threadRoot: message.threadRoot,
        replyTo: message.replyTo,
        redacted: message.redacted,
      })),
    })
  }
  const lines = [`# ${input.roomName}`, ""]
  for (const message of input.messages) {
    const thread =
      message.threadRoot === null ? "" : ` · thread ${message.threadRoot}`
    lines.push(
      `## #${message.seq} @${message.authorName} (${stamp(message.createdAt)})${thread}`,
    )
    lines.push("")
    lines.push(message.body)
    lines.push("")
  }
  return lines.join("\n")
}
