import { describe, expect, test } from "bun:test";
import {
  agentInstructions,
  guideLines,
  skillMarkdown,
} from "../src/mcp/guide.ts";
import { serverInstructions, skillUri } from "../src/mcp/skill-catalog.ts";

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
    expect(serverInstructions).toBe(
      `${agentInstructions} Read ${skillUri} for the full guide.`
    );
    expect(skillUri).toBe("skill://agent-rooms/SKILL.md");
  });
});
