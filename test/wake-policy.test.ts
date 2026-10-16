import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { AgentId } from "../src/domain/ids.ts"
import {
  DEBOUNCE_MS,
  COOLDOWN_MS,
  HOP_LIMIT,
  classifyWakeStatus,
  deliveryNotBefore,
  planPost,
  retryDelayMs,
  tokensInBody,
  type WakeMember,
} from "../src/domain/wake-policy.ts"

const id = (hex: string) => Schema.decodeUnknownSync(AgentId)(`agent_${hex}`)

const ada = id("aaaaaaaaaaaaaaaaaaaaaaaa")
const bob = id("bbbbbbbbbbbbbbbbbbbbbbbb")
const cam = id("cccccccccccccccccccccccc")

const members: ReadonlyArray<WakeMember> = [
  { agentId: ada, displayName: "ada", kind: "agent" },
  { agentId: bob, displayName: "bob", kind: "agent" },
  { agentId: cam, displayName: "cam", kind: "human" },
]

describe("planPost", () => {
  test("rejects an agent post with no mention", () => {
    const plan = planPost({
      authorId: ada,
      authorKind: "agent",
      body: "hello",
      explicitMentions: [],
      members,
      hopCount: 0,
      paused: false,
    })
    expect(plan._tag).toBe("RejectUntagged")
  })

  test("wakes every agent when a human posts without a mention", () => {
    const plan = planPost({
      authorId: cam,
      authorKind: "human",
      body: "status?",
      explicitMentions: [],
      members,
      hopCount: 4,
      paused: true,
    })
    expect(plan._tag).toBe("Accept")
    if (plan._tag !== "Accept") return
    expect(plan.targets).toEqual([ada, bob])
    expect(plan.storedMentions).toEqual(["all"])
    expect(plan.resetHops).toBe(true)
    expect(plan.nextHopCount).toBe(0)
    expect(plan.paused).toBe(false)
  })

  test("does not wake the author", () => {
    const plan = planPost({
      authorId: ada,
      authorKind: "agent",
      body: "look @ada @bob",
      explicitMentions: [],
      members,
      hopCount: 0,
      paused: false,
    })
    expect(plan._tag).toBe("Accept")
    if (plan._tag !== "Accept") return
    expect(plan.targets).toEqual([bob])
    expect(plan.nextHopCount).toBe(1)
  })

  test("rejects a mention that matches nobody", () => {
    const plan = planPost({
      authorId: ada,
      authorKind: "agent",
      body: "@nobody",
      explicitMentions: [],
      members,
      hopCount: 0,
      paused: false,
    })
    expect(plan).toEqual({ _tag: "UnknownMention", token: "nobody" })
  })

  test("rejects a self-only mention", () => {
    const plan = planPost({
      authorId: ada,
      authorKind: "agent",
      body: "@ada",
      explicitMentions: [],
      members,
      hopCount: 0,
      paused: false,
    })
    expect(plan._tag).toBe("SelfMentionOnly")
  })

  test("pauses at the hop limit and notifies the human once", () => {
    const plan = planPost({
      authorId: ada,
      authorKind: "agent",
      body: "@bob",
      explicitMentions: [],
      members,
      hopCount: HOP_LIMIT,
      paused: false,
    })
    expect(plan._tag).toBe("Accept")
    if (plan._tag !== "Accept") return
    expect(plan.targets).toEqual([])
    expect(plan.paused).toBe(true)
    expect(plan.notifyHuman).toBe(true)
    expect(plan.nextHopCount).toBe(HOP_LIMIT)
  })

  test("does not notify again while already paused", () => {
    const plan = planPost({
      authorId: ada,
      authorKind: "agent",
      body: "@bob",
      explicitMentions: [],
      members,
      hopCount: HOP_LIMIT,
      paused: true,
    })
    expect(plan._tag).toBe("Accept")
    if (plan._tag !== "Accept") return
    expect(plan.notifyHuman).toBe(false)
    expect(plan.targets).toEqual([])
  })

  test("accepts an explicit mention list", () => {
    const plan = planPost({
      authorId: ada,
      authorKind: "agent",
      body: "ping",
      explicitMentions: ["bob"],
      members,
      hopCount: 0,
      paused: false,
    })
    expect(plan._tag).toBe("Accept")
    if (plan._tag !== "Accept") return
    expect(plan.targets).toEqual([bob])
  })
})

describe("delivery timing", () => {
  test("debounces a few seconds and respects cooldown", () => {
    expect(deliveryNotBefore(1_000, undefined)).toBe(1_000 + DEBOUNCE_MS)
    expect(deliveryNotBefore(10_000, 9_000)).toBe(9_000 + COOLDOWN_MS)
    expect(deliveryNotBefore(20_000, 1_000)).toBe(20_000 + DEBOUNCE_MS)
  })

  test("backs off and caps retry delay", () => {
    expect(retryDelayMs(1)).toBe(2_000)
    expect(retryDelayMs(2)).toBe(4_000)
    expect(retryDelayMs(8)).toBe(30_000)
  })

  test("reads mention tokens from the body", () => {
    expect(tokensInBody("hi @bob and @ada")).toEqual(["bob", "ada"])
  })

  test("treats 202 as busy and any other 2xx as delivered", () => {
    expect(classifyWakeStatus(200)).toBe("delivered")
    expect(classifyWakeStatus(204)).toBe("delivered")
    expect(classifyWakeStatus(202)).toBe("busy")
    expect(classifyWakeStatus(500)).toBe("failed")
    expect(classifyWakeStatus(0)).toBe("failed")
  })
})
