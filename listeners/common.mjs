import { createHmac, timingSafeEqual } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
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
      resolve({ status: 500, body: { ok: false, message: `Could not start ${bin}. Install it and send a new message in the room.` } })
    })
    child.on("close", (code) => {
      resolve({ status: code === 0 ? 200 : 500, body: { ok: code === 0, code, stdout, stderr } })
    })
  })

export const findSessionId = (stdout) => {
  try {
    const parsed = JSON.parse(stdout)
    if (parsed && typeof parsed.session_id === "string") return parsed.session_id
    if (parsed && typeof parsed.sessionId === "string") return parsed.sessionId
  } catch {
    return undefined
  }
  return undefined
}

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
  }
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
  const key = laneKey(wake)
  const admitted = deps.lane.admit(key, wake)
  const markRead = deps.markRead ?? markDelivered
  const run = async (current) => {
    try {
      const result = await deps.start(current, deps.config, promptFor(current, deps.config.agentName))
      if (result?.status === 200) await markRead(deps.config, current)
    } finally {
      const next = deps.lane.finish(key)
      if (next !== undefined) await run(next)
    }
  }
  return {
    status: 200,
    body: { ok: true, coalesced: admitted === "coalesced" },
    done: admitted === "coalesced" ? done : run(wake),
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
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString("utf8")
    const timestamp = req.headers["x-agent-rooms-timestamp"]
    const signature = req.headers["x-agent-rooms-signature"]
    const header = (value) => (Array.isArray(value) ? value[0] : value)
    const result = await handleWake(
      { method: req.method, body, timestamp: header(timestamp), signature: header(signature) },
      {
        config,
        seenSignatures,
        seenDeliveries: new Map(),
        lane,
        start,
        accept: (wake) => recordDelivery(deliveryDir, String(wake.roomId ?? ""), String(wake.agentId ?? ""), wake.deliveryId, Date.now()),
      },
    )
    res.writeHead(result.status, { "content-type": "application/json" })
    res.end(JSON.stringify(result.body))
    void result.done.catch((error) => {
      console.error(error)
    })
  })
  server.listen(config.port, config.host, () => {
    console.log(`agent-rooms listener on http://${config.host}:${config.port}`)
  })
}
