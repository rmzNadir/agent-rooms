import { createHmac, timingSafeEqual } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { homedir } from "node:os"
import path from "node:path"

const maxSkewMs = 5 * 60 * 1000

export const verifySignature = (secret, timestamp, body, header) => {
  if (typeof secret !== "string" || typeof timestamp !== "string" || typeof body !== "string" || typeof header !== "string") {
    return false
  }
  const sentAt = Number(timestamp)
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > maxSkewMs) return false
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
  const presented = header.startsWith("sha256=") ? header.slice("sha256=".length) : header
  const left = Buffer.from(expected)
  const right = Buffer.from(presented)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export const signatureDigest = (header) => {
  if (typeof header !== "string") return ""
  const hex = header.startsWith("sha256=") ? header.slice("sha256=".length) : header
  return hex.toLowerCase()
}

export const rememberSignature = (seen, signature, now) => {
  for (const [key, expiresAt] of seen) {
    if (expiresAt <= now) seen.delete(key)
  }
  if (seen.has(signature)) return false
  seen.set(signature, now + maxSkewMs)
  return true
}

const stateDir = () => {
  const dir = path.join(homedir(), ".agent-rooms")
  mkdirSync(dir, { recursive: true })
  return dir
}

const sessionName = (roomId, agentId) => `${roomId}__${agentId}.json`

export const replaceFile = (tmp, dest, fsImpl = { renameSync, rmSync }) => {
  try {
    fsImpl.renameSync(tmp, dest)
  } catch {
    fsImpl.rmSync(dest, { force: true })
    fsImpl.renameSync(tmp, dest)
  }
}

const writeJsonAtomic = (dest, value) => {
  const tmp = `${dest}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  replaceFile(tmp, dest)
}

export const writeSessionFile = (dir, roomId, agentId, sessionId) => {
  mkdirSync(dir, { recursive: true })
  writeJsonAtomic(path.join(dir, sessionName(roomId, agentId)), { sessionId, updatedAt: Date.now() })
}

export const readSessionFile = (dir, roomId, agentId) => {
  const file = path.join(dir, sessionName(roomId, agentId))
  if (!existsSync(file)) return undefined
  const parsed = JSON.parse(readFileSync(file, "utf8"))
  return parsed !== null && typeof parsed === "object" && typeof parsed.sessionId === "string" ? parsed.sessionId : undefined
}

const sessionsDir = () => {
  const dir = path.join(stateDir(), "sessions")
  mkdirSync(dir, { recursive: true })
  return dir
}

export const writeSession = (roomId, agentId, sessionId) => {
  writeSessionFile(sessionsDir(), roomId, agentId, sessionId)
}

export const sessionFor = (roomId, agentId) => readSessionFile(sessionsDir(), roomId, agentId)

export const loadConfig = () => {
  const file = process.env.AGENT_ROOMS_LISTENER_CONFIG ?? path.join(process.cwd(), "agent-rooms.listener.json")
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
  const listen = process.env.AGENT_ROOMS_LISTEN ?? fromFile.listen ?? "127.0.0.1:8788"
  const [host, portText] = listen.split(":")
  return {
    host: host && host.length > 0 ? host : "127.0.0.1",
    port: Number(portText ?? 8788),
    webhookSecret: process.env.AGENT_ROOMS_WEBHOOK_SECRET ?? fromFile.webhookSecret,
    mcpUrl: process.env.AGENT_ROOMS_MCP_URL ?? fromFile.mcpUrl,
    bearerToken: process.env.AGENT_ROOMS_TOKEN ?? fromFile.bearerToken,
    agentName: process.env.AGENT_ROOMS_AGENT_NAME ?? fromFile.agentName ?? "agent",
    workdir: fromFile.workdir ?? process.cwd(),
    claudeBin: process.env.CLAUDE_BIN ?? fromFile.claudeBin ?? (process.platform === "win32" ? "claude.cmd" : "claude"),
    codexBin: process.env.CODEX_BIN ?? fromFile.codexBin ?? (process.platform === "win32" ? "codex.cmd" : "codex"),
    claudeExtraArgs: fromFile.claudeExtraArgs ?? [],
    codexExtraArgs: fromFile.codexExtraArgs ?? [],
  }
}

export const writeMcpConfig = (config) => {
  const file = path.join(stateDir(), "mcp.json")
  const document = {
    mcpServers: {
      "agent-rooms": {
        type: "http",
        url: config.mcpUrl,
        headers: { Authorization: `Bearer ${config.bearerToken}` },
      },
    },
  }
  writeFileSync(file, JSON.stringify(document, null, 2))
  return file
}

export const spawnHarness = ({ bin, args, cwd, env }) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", () => {
      resolve({ status: 500, body: { ok: false, message: `Could not start ${bin}. The listener will retry this wake.` } })
    })
    child.on("close", (code) => {
      resolve({ status: code === 0 ? 200 : 500, body: { ok: code === 0, code, stdout, stderr } })
    })
  })

const sessionIdOf = (parsed) => {
  if (parsed === null || typeof parsed !== "object") return undefined
  if (typeof parsed.session_id === "string") return parsed.session_id
  if (typeof parsed.sessionId === "string") return parsed.sessionId
  if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") return parsed.thread_id
  return undefined
}

// Claude prints one JSON object. `codex exec --json` prints JSON lines, and the session is the thread id.
export const findSessionId = (stdout) => {
  for (const line of [stdout, ...stdout.split("\n")]) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      const found = sessionIdOf(JSON.parse(trimmed))
      if (found !== undefined) return found
    } catch {
      continue
    }
  }
  return undefined
}

export const codexArgs = (extraArgs, previous, prompt) =>
  previous === undefined
    ? [...extraArgs, "exec", "--json", prompt]
    : [...extraArgs, "exec", "resume", "--json", previous, prompt]

export const deliveryTtlMs = 30 * 60 * 1000

export const acceptDelivery = (seen, deliveryId, now, ttl = deliveryTtlMs) => {
  if (typeof deliveryId !== "string" || deliveryId.length === 0) return "missing"
  for (const [key, expiresAt] of seen) {
    if (expiresAt <= now) seen.delete(key)
  }
  const expiresAt = seen.get(deliveryId)
  if (expiresAt !== undefined && expiresAt > now) return "duplicate"
  seen.set(deliveryId, now + ttl)
  return "fresh"
}

const readDeliveryMap = (file) => {
  const seen = new Map()
  if (!existsSync(file)) return seen
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (parsed === null || typeof parsed !== "object") return seen
    for (const [id, expiresAt] of Object.entries(parsed)) {
      if (typeof expiresAt === "number") seen.set(id, expiresAt)
    }
  } catch {
    return seen
  }
  return seen
}

export const recordDelivery = (dir, roomId, agentId, deliveryId, now) => {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${roomId}__${agentId}.json`)
  const seen = readDeliveryMap(file)
  const decision = acceptDelivery(seen, deliveryId, now)
  writeJsonAtomic(file, Object.fromEntries(seen))
  return decision
}

export const createLane = () => {
  const lanes = new Map()
  return {
    admit(key, wake) {
      const lane = lanes.get(key)
      if (lane !== undefined) {
        lane.followUp = wake
        return "coalesced"
      }
      lanes.set(key, { followUp: undefined })
      return "start"
    },
    finish(key) {
      const lane = lanes.get(key)
      if (lane === undefined) return undefined
      const next = lane.followUp
      if (next === undefined) {
        lanes.delete(key)
        return undefined
      }
      lane.followUp = undefined
      return next
    },
    release(key) {
      lanes.delete(key)
    },
  }
}

export const maxHarnessAttempts = 3

export const harnessRetryDelayMs = (attemptsSoFar) =>
  Math.min(30_000, 1_000 * 2 ** Math.max(0, attemptsSoFar - 1))

const pendingPath = (dir, roomId, agentId) => path.join(dir, `${roomId}__${agentId}.json`)

export const readPendingFile = (dir, roomId, agentId) => {
  const file = pendingPath(dir, roomId, agentId)
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (parsed === null || typeof parsed !== "object" || parsed.wake === undefined) return undefined
    if (typeof parsed.attempts !== "number" || typeof parsed.phase !== "string") return undefined
    return parsed
  } catch {
    return undefined
  }
}

export const writePendingFile = (dir, roomId, agentId, record) => {
  mkdirSync(dir, { recursive: true })
  writeJsonAtomic(pendingPath(dir, roomId, agentId), record)
}

export const removePendingFile = (dir, roomId, agentId) => {
  const file = pendingPath(dir, roomId, agentId)
  if (existsSync(file)) rmSync(file)
}

export const acceptPending = (dir, wake) => {
  const existing = readPendingFile(dir, wake.roomId, wake.agentId)
  if (existing?.wake?.deliveryId === wake.deliveryId) return "same"
  if (existing?.followUp?.deliveryId === wake.deliveryId) return "same"
  if (existing === undefined) {
    writePendingFile(dir, wake.roomId, wake.agentId, {
      wake,
      attempts: 0,
      phase: "queued",
      followUp: null,
    })
    return "start"
  }
  writePendingFile(dir, wake.roomId, wake.agentId, { ...existing, followUp: wake })
  return "queued"
}

export const failureBody = (wake) =>
  `@human I failed to process messages ${wake.fromSeq} through ${wake.toSeq} after ${maxHarnessAttempts} attempts.`

export const postFailure = async (config, wake, fetchImpl = globalThis.fetch) => {
  if (typeof config.mcpUrl !== "string" || typeof config.bearerToken !== "string") return false
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "post_message",
      arguments: { room: wake.roomId, body: failureBody(wake), mentions: ["human"] },
    },
  })
  try {
    const response = await fetchImpl(config.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.bearerToken}`,
      },
      body,
    })
    const text = await response.text()
    return response.ok && !text.includes("\"isError\":true")
  } catch {
    return false
  }
}

const listPending = (dir) => {
  if (!existsSync(dir)) return []
  const records = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue
    const roomAndAgent = name.slice(0, -".json".length).split("__")
    const roomId = roomAndAgent[0]
    const agentId = roomAndAgent[1]
    if (roomId === undefined || agentId === undefined) continue
    const record = readPendingFile(dir, roomId, agentId)
    if (record !== undefined) records.push(record)
  }
  return records
}

const seqText = (value) => (Number.isInteger(value) ? String(value) : undefined)

export const promptFor = (wake, agentName) => {
  const fromSeq = seqText(wake.fromSeq) ?? seqText(wake.sinceCursor) ?? "0"
  const toSeq = seqText(wake.toSeq)
  return [
    `You are ${agentName} in agent-rooms room ${wake.roomName} (${wake.roomId}).`,
    wake.youAreLead ? "You are the lead coordinator for this project. Keep the same session." : "You are a member of this project room.",
    toSeq === undefined
      ? `Call read_messages with since ${fromSeq} and read everything new, not only the triggering message.`
      : `Call read_messages with since ${fromSeq} and read through seq ${toSeq}.`,
    toSeq === undefined ? "Call mark_read with the last seq you read." : `Call mark_read with seq ${toSeq}.`,
    "Reply with post_message. Mention at least one other member, @all, or @human. Do not mention only yourself.",
    `Triggering message ids: ${(wake.triggeringMessageIds ?? []).join(", ") || "(none)"}.`,
    wake.paused ? "The room is paused. Mention @human and wait." : "The room is accepting agent wakes.",
  ].join("\n")
}

export const markDelivered = async (config, wake, fetchImpl = globalThis.fetch) => {
  const seq = Number.isInteger(wake.toSeq) ? wake.toSeq : Number.isInteger(wake.sinceCursor) ? wake.sinceCursor : undefined
  if (seq === undefined || typeof config.mcpUrl !== "string" || typeof config.bearerToken !== "string") return
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "mark_read", arguments: { room: wake.roomId, seq } },
  })
  await fetchImpl(config.mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.bearerToken}`,
    },
    body,
  }).catch(() => undefined)
}

const laneKey = (wake) => `${wake?.roomId ?? ""}:${wake?.agentId ?? ""}`

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const promoteOrDrop = (dir, roomId, agentId) => {
  const saved = readPendingFile(dir, roomId, agentId)
  const follow = saved?.followUp
  if (follow !== undefined && follow !== null) {
    writePendingFile(dir, follow.roomId, follow.agentId, {
      wake: follow,
      attempts: 0,
      phase: "queued",
      followUp: null,
    })
    return follow
  }
  removePendingFile(dir, roomId, agentId)
  return undefined
}

const drivePending = async (initial, deps) => {
  const dir = deps.pendingDir
  const markRead = deps.markRead ?? markDelivered
  const report = deps.reportFailure ?? postFailure
  const sleep = deps.sleep ?? wait
  let active = initial
  while (active !== undefined) {
    let record = readPendingFile(dir, active.roomId, active.agentId) ?? {
      wake: active,
      attempts: 0,
      phase: "queued",
      followUp: null,
    }
    if (record.phase === "running") {
      record = { ...record, wake: active, phase: "retry" }
      writePendingFile(dir, active.roomId, active.agentId, record)
    }
    if (record.phase === "succeeded") {
      try {
        await markRead(deps.config, active)
      } catch {
        return
      }
    } else if (record.phase !== "reported") {
      if (record.attempts >= maxHarnessAttempts || record.phase === "exhausted") {
        const posted = await report(deps.config, active)
        const latest = readPendingFile(dir, active.roomId, active.agentId)
        if (!posted) {
          writePendingFile(dir, active.roomId, active.agentId, {
            wake: active,
            attempts: Math.max(record.attempts, maxHarnessAttempts),
            phase: "exhausted",
            followUp: latest?.followUp ?? record.followUp ?? null,
          })
          return
        }
        const after = readPendingFile(dir, active.roomId, active.agentId)
        writePendingFile(dir, active.roomId, active.agentId, {
          wake: active,
          attempts: Math.max(record.attempts, maxHarnessAttempts),
          phase: "reported",
          followUp: after?.followUp ?? latest?.followUp ?? record.followUp ?? null,
        })
      } else {
        while (record.attempts < maxHarnessAttempts) {
          const attempts = record.attempts + 1
          writePendingFile(dir, active.roomId, active.agentId, {
            wake: active,
            attempts,
            phase: "running",
            followUp: record.followUp ?? null,
          })
          let result
          try {
            result = await deps.start(active, deps.config, promptFor(active, deps.config.agentName))
          } catch {
            result = { status: 500 }
          }
          const latest = readPendingFile(dir, active.roomId, active.agentId)
          const followUp = latest?.followUp ?? null
          if (result?.status === 200) {
            writePendingFile(dir, active.roomId, active.agentId, {
              wake: active,
              attempts,
              phase: "succeeded",
              followUp,
            })
            try {
              await markRead(deps.config, active)
            } catch {
              return
            }
            break
          }
          if (attempts >= maxHarnessAttempts) {
            const posted = await report(deps.config, active)
            const after = readPendingFile(dir, active.roomId, active.agentId)
            writePendingFile(dir, active.roomId, active.agentId, {
              wake: active,
              attempts,
              phase: posted ? "reported" : "exhausted",
              followUp: after?.followUp ?? followUp,
            })
            if (!posted) return
            break
          }
          record = { wake: active, attempts, phase: "retry", followUp }
          writePendingFile(dir, active.roomId, active.agentId, record)
          await sleep(harnessRetryDelayMs(attempts))
        }
      }
    }
    active = promoteOrDrop(dir, active.roomId, active.agentId)
  }
}

export const resumeUnfinished = async (dir, deps) => {
  const jobs = []
  for (const record of listPending(dir)) {
    if (record.phase === "reported" && (record.followUp === undefined || record.followUp === null)) {
      removePendingFile(dir, record.wake.roomId, record.wake.agentId)
      continue
    }
    const key = laneKey(record.wake)
    if (deps.lane.admit(key, record.wake) === "start") jobs.push(record)
  }
  const withDir = { ...deps, pendingDir: dir }
  for (const record of jobs) {
    const key = laneKey(record.wake)
    try {
      await drivePending(record.wake, withDir)
    } finally {
      deps.lane.release(key)
    }
  }
}

export const handleWake = async (http, deps) => {
  const now = deps.now ?? Date.now()
  const done = Promise.resolve()
  if (http.method !== "POST") return { status: 404, body: {}, done }
  if (
    !verifySignature(deps.config.webhookSecret, http.timestamp, http.body, http.signature) ||
    !rememberSignature(deps.seenSignatures, signatureDigest(http.signature), now)
  ) {
    return {
      status: 401,
      body: { ok: false, message: "Signature did not match. Check the webhook secret and clock." },
      done,
    }
  }
  let wake
  try {
    wake = JSON.parse(http.body)
  } catch {
    return { status: 400, body: { ok: false, message: "Wake body must be JSON." }, done }
  }
  const decision = typeof deps.accept === "function"
    ? deps.accept(wake)
    : acceptDelivery(deps.seenDeliveries, wake.deliveryId, now)
  if (decision === "missing") {
    return { status: 400, body: { ok: false, message: "Wake body needs a deliveryId." }, done }
  }
  if (decision === "duplicate") {
    return { status: 200, body: { ok: true, duplicate: true }, done }
  }
  const stored = deps.pendingDir ? acceptPending(deps.pendingDir, wake) : undefined
  if (stored === "same") {
    return { status: 200, body: { ok: true, duplicate: true }, done }
  }
  const key = laneKey(wake)
  const admitted = deps.lane.admit(key, wake)
  const markRead = deps.markRead ?? markDelivered
  const run = async (current) => {
    if (deps.pendingDir) {
      try {
        await drivePending(current, deps)
      } finally {
        deps.lane.release(key)
      }
      return
    }
    try {
      const result = await deps.start(current, deps.config, promptFor(current, deps.config.agentName))
      if (result?.status === 200) await markRead(deps.config, current)
    } finally {
      const next = deps.lane.finish(key)
      if (next !== undefined) await run(next)
    }
  }
  if (admitted === "coalesced") {
    return { status: 200, body: { ok: true, coalesced: true }, done }
  }
  const existing = deps.pendingDir ? readPendingFile(deps.pendingDir, wake.roomId, wake.agentId) : undefined
  const toRun = stored === "queued" && existing?.wake ? existing.wake : wake
  return {
    status: 200,
    body: { ok: true, coalesced: stored === "queued" },
    done: run(toRun),
  }
}

export const serve = (start) => {
  const config = loadConfig()
  if (typeof config.webhookSecret !== "string" || config.webhookSecret.length === 0) {
    console.error("Set webhookSecret in agent-rooms.listener.json or AGENT_ROOMS_WEBHOOK_SECRET.")
    process.exit(1)
  }
  const seenSignatures = new Map()
  const lane = createLane()
  const deliveryDir = path.join(stateDir(), "deliveries")
  const pendingDir = path.join(stateDir(), "pending")
  const listenerDeps = {
    config,
    seenSignatures,
    seenDeliveries: new Map(),
    lane,
    start,
    pendingDir,
    accept: (wake) => recordDelivery(deliveryDir, String(wake.roomId ?? ""), String(wake.agentId ?? ""), wake.deliveryId, Date.now()),
  }
  const resumed = resumeUnfinished(pendingDir, listenerDeps)
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString("utf8")
    const timestamp = req.headers["x-agent-rooms-timestamp"]
    const signature = req.headers["x-agent-rooms-signature"]
    const header = (value) => (Array.isArray(value) ? value[0] : value)
    const result = await handleWake(
      { method: req.method, body, timestamp: header(timestamp), signature: header(signature) },
      listenerDeps,
    )
    res.writeHead(result.status, { "content-type": "application/json" })
    res.end(JSON.stringify(result.body))
    void result.done.catch((error) => {
      console.error(error)
    })
  })
  void resumed.catch((error) => {
    console.error(error)
  })
  server.listen(config.port, config.host, () => {
    console.log(`agent-rooms listener on http://${config.host}:${config.port}`)
  })
}
