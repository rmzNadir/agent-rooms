import { findSessionId, serve, sessionFor, spawnHarness, writeSession } from "./common.mjs"

serve(async (wake, config, prompt) => {
  const previous = sessionFor(wake.roomId, wake.agentId)
  const args = [...config.codexExtraArgs, "exec"]
  if (previous !== undefined) args.push("resume", previous)
  args.push(prompt)
  const result = await spawnHarness({
    bin: config.codexBin,
    args,
    cwd: config.workdir,
    env: { AGENT_ROOMS_TOKEN: config.bearerToken },
  })
  const sessionId = findSessionId(result.body.stdout ?? "")
  if (sessionId !== undefined) writeSession(wake.roomId, wake.agentId, sessionId)
  return result
})
