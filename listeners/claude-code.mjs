import { findSessionId, serve, sessionFor, spawnHarness, writeMcpConfig, writeSession } from "./common.mjs"

serve(async (wake, config, prompt) => {
  const mcpConfig = writeMcpConfig(config)
  const previous = sessionFor(wake.roomId)
  const args = [
    ...config.claudeExtraArgs,
    "-p",
    prompt,
    "--output-format",
    "json",
    "--mcp-config",
    mcpConfig,
  ]
  if (previous !== undefined) args.push("--resume", previous)
  const result = await spawnHarness({
    bin: config.claudeBin,
    args,
    cwd: config.workdir,
    env: { AGENT_ROOMS_TOKEN: config.bearerToken },
    roomId: wake.roomId,
  })
  const sessionId = findSessionId(result.body.stdout ?? "")
  if (sessionId !== undefined) writeSession(wake.roomId, sessionId)
  return result
})
