import { createHmac } from "node:crypto"
import { expect, test } from "bun:test"
import { createLane, handleWake } from "../listeners/common.mjs"

const secret = "sek"
const roomId = "room_0123456789abcdef01234567"
const agentId = "agent_0123456789abcdef01234567"

const signed = (wake: Record<string, unknown>, now: number) => {
  const body = JSON.stringify(wake)
  const timestamp = String(now)
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
  return { body, timestamp, signature: `sha256=${signature}` }
}

const wake = (deliveryId: string, seq: number) => ({
  roomId,
  roomName: "launch",
  agentId,
  deliveryId,
  fromSeq: 4,
  toSeq: seq,
  sinceCursor: 4,
  triggeringMessageIds: [`msg_${seq}`],
  youAreLead: true,
  paused: false,
  hopCount: 1,
})

const harness = () => {
  const started: string[] = []
  const marks: number[] = []
  let release: ((result: { status: number; body: { ok: boolean } }) => void) | undefined
  const start = (payload: { deliveryId: string }, _config: unknown, prompt: string) =>
    new Promise<{ status: number; body: { ok: boolean; prompt: string } }>((resolve) => {
      started.push(payload.deliveryId)
      release = (result) => resolve({ ...result, body: { ...result.body, prompt } })
    })
  return {
    started,
    marks,
    start,
    finish: (status = 200) => {
      const current = release
      release = undefined
      current?.({ status, body: { ok: status === 200 } })
    },
    deps: () => ({
      config: {
        webhookSecret: secret,
        agentName: "ada",
        mcpUrl: "http://127.0.0.1:9/mcp",
        bearerToken: "tok",
      },
      seenSignatures: new Map(),
      seenDeliveries: new Map(),
      lane: createLane(),
      now: Date.now(),
      start,
      markRead: async (_config: unknown, payload: { toSeq: number }) => {
        marks.push(payload.toSeq)
      },
    }),
  }
}

test("acks a verified wake before the harness exits and runs it after", async () => {
  const run = harness()
  const now = Date.now()
  const http = signed(wake("dlv_1", 9), now)
  const response = await handleWake({ method: "POST", ...http }, run.deps())
  expect(response.status).toBe(200)
  expect(response.body).toEqual({ ok: true, coalesced: false })
  expect(run.started).toEqual(["dlv_1"])
  expect(run.marks).toEqual([])
  run.finish()
  await response.done
  expect(run.marks).toEqual([9])
})

test("one room and agent runs once, and later wakes become a single follow-up", async () => {
  const run = harness()
  const deps = run.deps()
  const now = Date.now()
  const first = await handleWake({ method: "POST", ...signed(wake("dlv_1", 9), now) }, deps)
  const second = await handleWake({ method: "POST", ...signed(wake("dlv_2", 10), now) }, deps)
  const third = await handleWake({ method: "POST", ...signed(wake("dlv_3", 11), now) }, deps)
  expect(second.body).toEqual({ ok: true, coalesced: true })
  expect(third.body).toEqual({ ok: true, coalesced: true })
  expect(run.started).toEqual(["dlv_1"])
  run.finish()
  for (let i = 0; i < 8 && run.started.length < 2; i++) await Promise.resolve()
  expect(run.started).toEqual(["dlv_1", "dlv_3"])
  run.finish()
  await first.done
  expect(run.marks).toEqual([9, 11])
})

test("a repeated delivery id does not start another run", async () => {
  const run = harness()
  const deps = run.deps()
  const now = Date.now()
  const http = signed(wake("dlv_1", 9), now)
  const first = await handleWake({ method: "POST", ...http }, deps)
  const retry = signed(wake("dlv_1", 9), now + 1)
  const again = await handleWake({ method: "POST", ...retry }, deps)
  expect(again.status).toBe(200)
  expect(again.body).toEqual({ ok: true, duplicate: true })
  expect(run.started).toEqual(["dlv_1"])
  run.finish()
  await first.done
})

test("the prompt tells the harness the unseen seq range", async () => {
  const run = harness()
  const now = Date.now()
  let prompt = ""
  const deps = run.deps()
  deps.start = (payload, _config, text) => {
    prompt = text
    run.started.push(payload.deliveryId)
    return Promise.resolve({ status: 200, body: { ok: true, prompt: text } })
  }
  const response = await handleWake({ method: "POST", ...signed(wake("dlv_9", 9), now) }, deps)
  await response.done
  expect(prompt).toContain("since 4")
  expect(prompt).toContain("seq 9")
})
