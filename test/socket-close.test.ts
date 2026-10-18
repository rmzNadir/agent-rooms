import { expect, test } from "bun:test";
import { socketIdsForAgent } from "../src/domain/sockets.ts";

test("leave closes only the sockets for that member", () => {
  const open = [
    { agentId: "agent_aaaaaaaaaaaaaaaaaaaaaaaa", id: "s1" },
    { agentId: "agent_bbbbbbbbbbbbbbbbbbbbbbbb", id: "s2" },
    { agentId: "agent_aaaaaaaaaaaaaaaaaaaaaaaa", id: "s3" },
  ];
  expect(socketIdsForAgent(open, "agent_aaaaaaaaaaaaaaaaaaaaaaaa")).toEqual([
    "s1",
    "s3",
  ]);
  expect(socketIdsForAgent(open, "agent_cccccccccccccccccccccccc")).toEqual([]);
});
