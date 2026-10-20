import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { AgentId } from "../src/domain/ids.ts";
import {
  COOLDOWN_MS,
  classifyWakeStatus,
  DEBOUNCE_MS,
  deliveryNotBefore,
  HOP_LIMIT,
  planPost,
  retryDelayMs,
  tokensInBody,
  type WakeMember,
} from "../src/domain/wake-policy.ts";

const id = (hex: string) => Schema.decodeUnknownSync(AgentId)(`agent_${hex}`);

const ada = id("aaaaaaaaaaaaaaaaaaaaaaaa");
const bob = id("bbbbbbbbbbbbbbbbbbbbbbbb");
const cam = id("cccccccccccccccccccccccc");
const dee = id("dddddddddddddddddddddddd");

const members: readonly WakeMember[] = [
  { agentId: ada, displayName: "ada", kind: "agent" },
  { agentId: bob, displayName: "bob", kind: "agent" },
  { agentId: cam, displayName: "cam", kind: "human" },
  { agentId: dee, displayName: "dee", kind: "human" },
];

const agentPost = (body: string, hopCount: number, paused: boolean) => {
  const plan = planPost({
    authorId: ada,
    authorKind: "agent",
    body,
    explicitMentions: [],
    hopCount,
    members,
    paused,
  });
  if (plan._tag !== "Accept") {
    throw new Error(plan._tag);
  }
  return plan;
};

const accepted = (body: string, explicitMentions: readonly string[]) => {
  const plan = planPost({
    authorId: ada,
    authorKind: "agent",
    body,
    explicitMentions,
    hopCount: 0,
    members,
    paused: false,
  });
  if (plan._tag !== "Accept") {
    throw new Error(plan._tag);
  }
  return plan;
};

describe("planPost", () => {
  test("rejects an agent post with no mention", () => {
    const plan = planPost({
      authorId: ada,
      authorKind: "agent",
      body: "hello",
      explicitMentions: [],
      hopCount: 0,
      members,
      paused: false,
    });
    expect(plan._tag).toBe("RejectUntagged");
  });

  test("wakes every agent when a human posts without a mention", () => {
    const plan = planPost({
      authorId: cam,
      authorKind: "human",
      body: "status?",
      explicitMentions: [],
      hopCount: 4,
      members,
      paused: true,
    });
    expect(plan._tag).toBe("Accept");
    if (plan._tag !== "Accept") {
      return;
    }
    expect(plan.targets).toEqual([ada, bob]);
    expect(plan.storedMentions).toEqual(["all"]);
    expect(plan.resetHops).toBe(true);
    expect(plan.nextHopCount).toBe(0);
    expect(plan.paused).toBe(false);
    expect(plan.notifyHuman).toBe(false);
  });

  test("does not wake the author", () => {
    const plan = accepted("look @ada @bob", []);
    expect(plan.targets).toEqual([bob]);
    expect(plan.nextHopCount).toBe(1);
  });

  test("rejects a mention that matches nobody", () => {
    const plan = planPost({
      authorId: ada,
      authorKind: "agent",
      body: "@nobody",
      explicitMentions: [],
      hopCount: 0,
      members,
      paused: false,
    });
    expect(plan).toEqual({ _tag: "UnknownMention", token: "nobody" });
  });

  test("rejects a self-only mention", () => {
    const plan = planPost({
      authorId: ada,
      authorKind: "agent",
      body: "@ada",
      explicitMentions: [],
      hopCount: 0,
      members,
      paused: false,
    });
    expect(plan._tag).toBe("SelfMentionOnly");
  });

  test("pauses at the hop limit and notifies the human once", () => {
    const plan = planPost({
      authorId: ada,
      authorKind: "agent",
      body: "@bob",
      explicitMentions: [],
      hopCount: HOP_LIMIT,
      members,
      paused: false,
    });
    expect(plan._tag).toBe("Accept");
    if (plan._tag !== "Accept") {
      return;
    }
    expect(plan.targets).toEqual([]);
    expect(plan.paused).toBe(true);
    expect(plan.notifyHuman).toBe(true);
    expect(plan.nextHopCount).toBe(HOP_LIMIT);
  });

  test("does not notify again while already paused", () => {
    const plan = agentPost("@bob", HOP_LIMIT, true);
    expect(plan.notifyHuman).toBe(false);
    expect(plan.targets).toEqual([]);
  });

  test("accepts an explicit mention list", () => {
    const plan = accepted("ping", ["bob"]);
    expect(plan.targets).toEqual([bob]);
    expect(plan.notifyHuman).toBe(false);
    expect(plan.paused).toBe(false);
    expect(plan.resetHops).toBe(false);
    expect(plan.nextHopCount).toBe(1);
  });

  test("keeps one copy of a repeated mention and strips a leading at sign", () => {
    expect(tokensInBody("@bob @bob")).toEqual(["bob"]);
    const plan = accepted("ping", ["@bob", ""]);
    expect(plan.targets).toEqual([bob]);
    expect(plan.storedMentions).toEqual(["bob"]);
  });

  test("treats all and human mentions without waking the author", () => {
    const everyone = accepted("@ALL", []);
    expect(everyone.targets).toEqual([bob]);
    expect(everyone.storedMentions).toEqual(["ALL"]);
    const human = accepted("@Human @ada", []);
    expect(human._tag).toBe("Accept");
    expect(human.targets).toEqual([]);
    expect(human.nextHopCount).toBe(0);
    const byId = accepted("ping", [bob]);
    expect(byId.targets).toEqual([bob]);
    const humanTarget = accepted("@cam", []);
    expect(humanTarget.targets).toEqual([]);
    expect(accepted("@bob @bob", []).targets).toEqual([bob]);
    const otherHuman = planPost({
      authorId: cam,
      authorKind: "human",
      body: "@dee",
      explicitMentions: [],
      hopCount: 0,
      members,
      paused: false,
    });
    expect(otherHuman._tag).toBe("Accept");
    if (otherHuman._tag === "Accept") {
      expect(otherHuman.targets).toEqual([]);
    }
  });

  test("a human mention names that agent and stores the token", () => {
    const plan = planPost({
      authorId: cam,
      authorKind: "human",
      body: "ping",
      explicitMentions: ["bob"],
      hopCount: 3,
      members,
      paused: false,
    });
    expect(plan._tag).toBe("Accept");
    if (plan._tag !== "Accept") {
      return;
    }
    expect(plan.targets).toEqual([bob]);
    expect(plan.storedMentions).toEqual(["bob"]);
    expect(plan.resetHops).toBe(true);
    expect(plan.nextHopCount).toBe(0);
    expect(plan.notifyHuman).toBe(false);
    const ignored = planPost({
      authorId: cam,
      authorKind: "human",
      body: "@cam",
      explicitMentions: [],
      hopCount: 1,
      members,
      paused: false,
    });
    expect(ignored._tag).toBe("Accept");
    if (ignored._tag !== "Accept") {
      return;
    }
    expect(ignored.targets).toEqual([]);
  });

  test("does not notify a human when the hop limit has nobody to wake", () => {
    const plan = agentPost("@human", HOP_LIMIT, false);
    expect(plan.notifyHuman).toBe(false);
    expect(plan.targets).toEqual([]);
    expect(plan.resetHops).toBe(false);
    expect(plan.paused).toBe(true);
  });
});

describe("delivery timing", () => {
  test("debounces a few seconds and respects cooldown", () => {
    expect(deliveryNotBefore(1000, undefined)).toBe(1000 + DEBOUNCE_MS);
    expect(deliveryNotBefore(10_000, 9000)).toBe(9000 + COOLDOWN_MS);
    expect(deliveryNotBefore(20_000, 1000)).toBe(20_000 + DEBOUNCE_MS);
  });

  test("backs off and caps retry delay", () => {
    expect(retryDelayMs(1)).toBe(2000);
    expect(retryDelayMs(2)).toBe(4000);
    expect(retryDelayMs(8)).toBe(30_000);
  });

  test("reads mention tokens from the body", () => {
    expect(tokensInBody("hi @bob and @ada")).toEqual(["bob", "ada"]);
    expect(tokensInBody("mail ada@bob.com")).toEqual([]);
  });

  test("matches display names exactly", () => {
    const plan = planPost({
      authorId: ada,
      authorKind: "agent",
      body: "@Ada",
      explicitMentions: [],
      hopCount: 0,
      members,
      paused: false,
    });
    expect(plan).toEqual({ _tag: "UnknownMention", token: "Ada" });
  });

  test("treats 202 as busy and any other 2xx as delivered", () => {
    expect(classifyWakeStatus(200)).toBe("delivered");
    expect(classifyWakeStatus(204)).toBe("delivered");
    expect(classifyWakeStatus(202)).toBe("busy");
    expect(classifyWakeStatus(299)).toBe("delivered");
    expect(classifyWakeStatus(300)).toBe("failed");
    expect(classifyWakeStatus(500)).toBe("failed");
    expect(classifyWakeStatus(0)).toBe("failed");
  });
});
