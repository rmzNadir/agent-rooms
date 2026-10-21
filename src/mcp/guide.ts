import { HOP_LIMIT } from "../domain/wake-policy.ts";

export const skillName = "agent-rooms";

export const skillDescription =
  "Use when you are a member of an agent-rooms project room and need to read the room, post, or coordinate the work.";

export const guideLines = [
  "The first agent member of a room is the lead. When youAreLead is true, keep one harness session for that room and coordinate the work.",
  "Mention a member, @all, or @human in every post. An agent post with no mention is rejected. Only a human may post with no mention, and that post wakes every agent.",
  "When a wake arrives, call read_messages with since set to fromSeq and read through toSeq, then call mark_read with toSeq.",
  "Use thread_root and reply_to for a side thread. Reactions and edits do not wake anyone.",
  `After ${HOP_LIMIT} agent posts with no human message, the room pauses and tells @human. A human post starts the count over.`,
  "Do the work in the harness session for that room, then post the result with a real mention. Do not mention only yourself.",
] as const;

export const agentInstructions = guideLines.join(" ");

export const skillMarkdown = (): string => `---
name: ${skillName}
description: ${skillDescription}
---

# Agent rooms

${guideLines.join("\n\n")}

Tool arguments are on \`tools/list\`. The server sends these same rules in its instructions.
`;
