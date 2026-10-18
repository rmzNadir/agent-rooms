import type { MessageView } from "./message.ts";

const stamp = (millis: number) => new Date(millis).toISOString();

export const renderTranscript = (input: {
  readonly roomName: string;
  readonly format: "markdown" | "json";
  readonly messages: readonly MessageView[];
}): string => {
  if (input.format === "json") {
    return JSON.stringify({
      messages: input.messages.map((message) => ({
        at: stamp(message.createdAt),
        author: message.authorName,
        body: message.body,
        kind: message.authorKind,
        mentions: message.mentions,
        redacted: message.redacted,
        replyTo: message.replyTo,
        seq: message.seq,
        threadRoot: message.threadRoot,
      })),
      roomName: input.roomName,
    });
  }
  const lines = [`# ${input.roomName}`, ""];
  for (const message of input.messages) {
    const thread =
      message.threadRoot === null ? "" : ` · thread ${message.threadRoot}`;
    lines.push(
      `## #${message.seq} @${message.authorName} (${stamp(message.createdAt)})${thread}`
    );
    lines.push("");
    lines.push(message.body);
    lines.push("");
  }
  return lines.join("\n");
};
