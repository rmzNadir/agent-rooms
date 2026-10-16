import { createHmac, timingSafeEqual } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { homedir } from "node:os"
import path from "node:path"

const maxSkewMs = 5 * 60 * 1000

/**
 * Verify `x-agent-rooms-signature` over `` `${timestamp}.${body}` ``.
 * Rejects timestamps more than five minutes from the local clock.
 */
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

const stateDir = () => {
  const dir = path.join(homedir(), ".agent-rooms")
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Room id to harness session id, so the same coordinator keeps going per project. */
export const readSessions = () => {
  const file = path.join(stateDir(), "sessions.json")
  if (!existsSync(file)) return {}
  const parsed = JSON.parse(readFileSync(file, "utf8"))
  return parsed !== null && typeof parsed === "object" ? parsed : {}
}

export const writeSession = (roomId, sessionId) => {
  const sessions = readSessions()
  sessions[roomId] = { sessionId, updatedAt: Date.now() }
  writeFileSync(path.join(stateDir(), "sessions.json"), JSON.stringify(sessions, null, 2))
}

export const sessionFor = (roomId) => {
  const row = readSessions()[roomId]
  return row && typeof row.sessionId === "string" ? row.sessionId : undefined
}

/** Load listener config from env, then from AGENT_ROOMS_LISTENER_CONFIG or ./agent-rooms.listener.json. */
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

const running = new Map()

/**
 * Start a headless harness for one room. A second wake while that room's
 * process is still running is acknowledged and not started again.
 */
export const spawnHarness = ({ bin, args, cwd, env, roomId }) =>
  new Promise((resolve) => {
    if (running.has(roomId)) {
      resolve({ status: 202, body: { ok: true, coalesced: true } })
      return
    }
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: process.platform === "win32",
      windowsHide: true,
    })
    running.set(roomId, child)
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
      running.delete(roomId)
      resolve({ status: 500, body: { ok: false, message: `Could not start ${bin}. Install it and retry; the room will deliver the wake again.` } })
    })
    child.on("close", (code) => {
      running.delete(roomId)
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

const promptFor = (wake, agentName) =>
  [
    `You are ${agentName} in agent-rooms room ${wake.roomName} (${wake.roomId}).`,
    wake.youAreLead ? "You are the lead coordinator for this project. Keep the same session." : "You are a member of this project room.",
    `Call read_messages with since ${wake.sinceCursor} and read everything new, not only the triggering message.`,
    "Reply with post_message. Mention at least one other member, @all, or @human. Do not mention only yourself.",
    `Triggering message ids: ${(wake.triggeringMessageIds ?? []).join(", ") || "(none)"}.`,
    wake.paused ? "The room is paused. Mention @human and wait." : "The room is accepting agent wakes.",
  ].join("\n")

/**
 * HTTP listener. `start` receives a verified wake and returns `{ status, body }`.
 * @param {(wake: object, config: object) => Promise<{ status: number, body: object }>} start
 */
export const serve = (start) => {
  const config = loadConfig()
  if (typeof config.webhookSecret !== "string" || config.webhookSecret.length === 0) {
    console.error("Set webhookSecret in agent-rooms.listener.json or AGENT_ROOMS_WEBHOOK_SECRET.")
    process.exit(1)
  }
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404)
      res.end()
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString("utf8")
    const timestamp = req.headers["x-agent-rooms-timestamp"]
    const signature = req.headers["x-agent-rooms-signature"]
    if (!verifySignature(config.webhookSecret, timestamp, body, signature)) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: false, message: "Signature did not match. Check the webhook secret and clock." }))
      return
    }
    let wake
    try {
      wake = JSON.parse(body)
    } catch {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: false, message: "Wake body must be JSON." }))
      return
    }
    const result = await start(wake, config, promptFor(wake, config.agentName))
    res.writeHead(result.status, { "content-type": "application/json" })
    res.end(JSON.stringify(result.body))
  })
  server.listen(config.port, config.host, () => {
    console.log(`agent-rooms listener on http://${config.host}:${config.port}`)
  })
}
