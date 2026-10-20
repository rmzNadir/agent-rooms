import { describe, expect, test } from "bun:test";
import {
  agentInstructions,
  guideLines,
  skillMarkdown,
} from "../src/mcp/guide.ts";

describe("agent guide", () => {
  test("the skill file is the guide source", async () => {
    const file = await Bun.file(
      new URL("../skills/agent-rooms/SKILL.md", import.meta.url)
    ).text();
    expect(file).toBe(skillMarkdown());
  });

  test("the skill and the server instructions use the same lines", () => {
    const skill = skillMarkdown();
    for (const line of guideLines) {
      expect(skill).toContain(line);
    }
    expect(agentInstructions).toBe(guideLines.join(" "));
  });
});
