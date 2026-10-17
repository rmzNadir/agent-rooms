import { createHmac } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { createLane, handleWake } from "../listeners/common.mjs"
import type { PendingRecord } from "../listeners/common.mjs"

const pendingApi = async () => {
  const mod = await import("../listeners/common.mjs")
  if (
    typeof mod.readPendingFile !== "function" ||
    typeof mod.writePendingFile !== "function" ||
    typeof mod.resumeUnfinished !== "function" ||
    typeof mod.postFailure !== "function"
  ) {
    throw new Error("listener does not persist an unfinished wake")
  }
  return mod
}

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

const pendingDir = () => mkdtempSync(path.join(tmpdir(), "agent-rooms-pending-"))

const failingDeps = (dir: string, start: (payload: { deliveryId: string; fromSeq: number; toSeq: number }) => Promise<{ status: number; body: { ok: boolean } }>) => {
  const marks: number[] = []
  const delays: number[] = []
  const reports: string[] = []
  return {
    marks,
    delays,
    reports,
    deps: {
      config: {
        webhookSecret: secret,
        agentName: "ada",
        mcpUrl: "http://127.0.0.1:9/mcp",
        bearerToken: "tok",
      },
      seenSignatures: new Map<string, number>(),
      seenDeliveries: new Map<string, number>(),
      lane: createLane(),
      now: Date.now(),
      pendingDir: dir,
      sleep: async (ms: number) => {
        delays.push(ms)
      },
      start,
      markRead: async (_config: unknown, payload: { toSeq: number }) => {
        marks.push(payload.toSeq)
      },
      reportFailure: async (_config: unknown, payload: { fromSeq: number; toSeq: number }) => {
        reports.push(`@human I failed to process messages ${payload.fromSeq} through ${payload.toSeq} after 3 attempts.`)
        return true
      },
    },
  }
}

test("the accepted seq range is on disk before the harness runs", async () => {
  const { readPendingFile } = await pendingApi()
  const dir = pendingDir()
  let saved: PendingRecord | undefined
  const run = failingDeps(dir, async () => {
    saved = readPendingFile(dir, roomId, agentId)
    return { status: 200, body: { ok: true } }
  })
  const response = await handleWake({ method: "POST", ...signed(wake("dlv_disk", 9), Date.now()) }, run.deps)
  expect(response.status).toBe(200)
  expect(saved?.wake?.deliveryId).toBe("dlv_disk")
  expect(saved?.wake?.fromSeq).toBe(4)
  expect(saved?.wake?.toSeq).toBe(9)
  expect(saved?.attempts).toBe(1)
  await response.done
  expect(run.marks).toEqual([9])
  expect(readPendingFile(dir, roomId, agentId)).toBeUndefined()
})

test("a non-zero harness is retried and mark_read runs once after success", async () => {
  const { readPendingFile } = await pendingApi()
  const dir = pendingDir()
  let calls = 0
  const run = failingDeps(dir, async () => {
    calls += 1
    return { status: calls < 3 ? 500 : 200, body: { ok: calls >= 3 } }
  })
  const response = await handleWake({ method: "POST", ...signed(wake("dlv_retry", 9), Date.now()) }, run.deps)
  expect(response.status).toBe(200)
  expect(response.body).toEqual({ ok: true, coalesced: false })
  await response.done
  expect(calls).toBe(3)
  expect(run.delays).toEqual([1000, 2000])
  expect(run.marks).toEqual([9])
  expect(readPendingFile(dir, roomId, agentId)).toBeUndefined()
})

test("a thrown harness is the same as a non-zero exit", async () => {
  await pendingApi()
  const dir = pendingDir()
  let calls = 0
  const run = failingDeps(dir, async () => {
    calls += 1
    if (calls < 3) throw new Error("harness crashed")
    return { status: 200, body: { ok: true } }
  })
  const response = await handleWake({ method: "POST", ...signed(wake("dlv_throw", 9), Date.now()) }, run.deps)
  await response.done
  expect(calls).toBe(3)
  expect(run.marks).toEqual([9])
  expect(run.delays).toEqual([1000, 2000])
})

test("three failures tell @human and do not mark the range read", async () => {
  const { readPendingFile } = await pendingApi()
  const dir = pendingDir()
  let calls = 0
  const run = failingDeps(dir, async () => {
    calls += 1
    return { status: 500, body: { ok: false } }
  })
  const response = await handleWake({ method: "POST", ...signed(wake("dlv_giveup", 9), Date.now()) }, run.deps)
  await response.done
  expect(calls).toBe(3)
  expect(run.marks).toEqual([])
  expect(run.reports).toEqual(["@human I failed to process messages 4 through 9 after 3 attempts."])
  expect(readPendingFile(dir, roomId, agentId)).toBeUndefined()
})

test("a failure post that does not land stays pending for the next listener start", async () => {
  const { readPendingFile, resumeUnfinished } = await pendingApi()
  const dir = pendingDir()
  let calls = 0
  let posted = false
  const run = failingDeps(dir, async () => {
    calls += 1
    return { status: 500, body: { ok: false } }
  })
  run.deps.reportFailure = async () => posted
  const response = await handleWake({ method: "POST", ...signed(wake("dlv_stuck", 9), Date.now()) }, run.deps)
  await response.done
  expect(calls).toBe(3)
  const stuck = readPendingFile(dir, roomId, agentId)
  expect(stuck?.attempts).toBe(3)
  expect(stuck?.wake?.toSeq).toBe(9)
  posted = true
  const resumedStarts: string[] = []
  await resumeUnfinished(dir, {
    ...run.deps,
    lane: createLane(),
    start: async (payload: { deliveryId: string }) => {
      resumedStarts.push(payload.deliveryId)
      return { status: 200, body: { ok: true } }
    },
  })
  expect(resumedStarts).toEqual([])
  expect(run.marks).toEqual([])
  expect(readPendingFile(dir, roomId, agentId)).toBeUndefined()
})

test("a listener restart continues a crashed attempt and marks read only after success", async () => {
  const { readPendingFile, writePendingFile, resumeUnfinished } = await pendingApi()
  const dir = pendingDir()
  writePendingFile(dir, roomId, agentId, {
    wake: wake("dlv_crash", 9),
    attempts: 1,
    phase: "running",
    followUp: null,
  })
  let attemptsDuring = 0
  const marks: number[] = []
  await resumeUnfinished(dir, {
    config: { agentName: "ada", mcpUrl: "http://127.0.0.1:9/mcp", bearerToken: "tok" },
    lane: createLane(),
    pendingDir: dir,
    sleep: async () => undefined,
    start: async () => {
      attemptsDuring = readPendingFile(dir, roomId, agentId)?.attempts ?? 0
      return { status: 200, body: { ok: true } }
    },
    markRead: async (_config: unknown, payload: { toSeq: number }) => {
      marks.push(payload.toSeq)
    },
  })
  expect(attemptsDuring).toBe(2)
  expect(marks).toEqual([9])
  expect(readPendingFile(dir, roomId, agentId)).toBeUndefined()
})

test("a restart after the last crashed attempt posts @human and does not run the harness", async () => {
  const { readPendingFile, writePendingFile, resumeUnfinished } = await pendingApi()
  const dir = pendingDir()
  writePendingFile(dir, roomId, agentId, {
    wake: wake("dlv_last", 9),
    attempts: 3,
    phase: "running",
    followUp: null,
  })
  const reports: string[] = []
  const starts: string[] = []
  await resumeUnfinished(dir, {
    config: { agentName: "ada" },
    lane: createLane(),
    pendingDir: dir,
    sleep: async () => undefined,
    start: async (payload: { deliveryId: string }) => {
      starts.push(payload.deliveryId)
      return { status: 200, body: { ok: true } }
    },
    reportFailure: async (_config: unknown, payload: { fromSeq: number; toSeq: number }) => {
      reports.push(`${payload.fromSeq}-${payload.toSeq}`)
      return true
    },
  })
  expect(starts).toEqual([])
  expect(reports).toEqual(["4-9"])
  expect(readPendingFile(dir, roomId, agentId)).toBeUndefined()
})

test("a restart after a successful harness only marks the range read", async () => {
  const { readPendingFile, writePendingFile, resumeUnfinished } = await pendingApi()
  const dir = pendingDir()
  writePendingFile(dir, roomId, agentId, {
    wake: wake("dlv_done", 9),
    attempts: 2,
    phase: "succeeded",
    followUp: null,
  })
  const marks: number[] = []
  const starts: string[] = []
  await resumeUnfinished(dir, {
    config: { agentName: "ada" },
    lane: createLane(),
    pendingDir: dir,
    sleep: async () => undefined,
    start: async (payload: { deliveryId: string }) => {
      starts.push(payload.deliveryId)
      return { status: 500, body: { ok: false } }
    },
    markRead: async (_config: unknown, payload: { toSeq: number }) => {
      marks.push(payload.toSeq)
    },
  })
  expect(starts).toEqual([])
  expect(marks).toEqual([9])
  expect(readPendingFile(dir, roomId, agentId)).toBeUndefined()
})

test("a wake that arrives during a retry is run after the current range succeeds", async () => {
  const { readPendingFile } = await pendingApi()
  const dir = pendingDir()
  const run = harness()
  const deps = { ...run.deps(), pendingDir: dir, sleep: async () => undefined }
  const now = Date.now()
  const first = await handleWake({ method: "POST", ...signed(wake("dlv_1", 9), now) }, deps)
  const second = await handleWake({ method: "POST", ...signed(wake("dlv_2", 11), now + 1) }, deps)
  expect(second.body).toEqual({ ok: true, coalesced: true })
  expect(readPendingFile(dir, roomId, agentId)?.followUp?.deliveryId).toBe("dlv_2")
  run.finish()
  for (let i = 0; i < 8 && run.started.length < 2; i++) await Promise.resolve()
  expect(run.started).toEqual(["dlv_1", "dlv_2"])
  run.finish()
  await first.done
  expect(run.marks).toEqual([9, 11])
  expect(readPendingFile(dir, roomId, agentId)).toBeUndefined()
})

test("postFailure asks the room to mention @human for the missed range", async () => {
  const { postFailure } = await pendingApi()
  let sent: { name?: string; arguments?: { room?: string; body?: string; mentions?: string[] } } | undefined
  const ok = await postFailure(
    { mcpUrl: "http://127.0.0.1/mcp", bearerToken: "tok" },
    { roomId, fromSeq: 4, toSeq: 9 },
    async (_url, init) => {
      sent = JSON.parse(init.body).params
      return { ok: true, text: async () => "{}" }
    },
  )
  expect(ok).toBe(true)
  expect(sent?.name).toBe("post_message")
  expect(sent?.arguments?.room).toBe(roomId)
  expect(sent?.arguments?.mentions).toEqual(["human"])
  expect(sent?.arguments?.body).toBe("@human I failed to process messages 4 through 9 after 3 attempts.")
  const rejected = await postFailure(
    { mcpUrl: "http://127.0.0.1/mcp", bearerToken: "tok" },
    { roomId, fromSeq: 4, toSeq: 9 },
    async () => ({ ok: true, text: async () => "{\"isError\":true}" }),
  )
  expect(rejected).toBe(false)
})
