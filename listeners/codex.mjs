import { codexArgs, findSessionId, serve, sessionFor, spawnHarness, writeSession } from "./common.mjs"

serve(async (wake, config, prompt) => {
  const result = await spawnHarness({
    bin: config.codexBin,
    args: codexArgs(config.codexExtraArgs, sessionFor(wake.roomId, wake.agentId), prompt),
    cwd: config.workdir,
    env: { AGENT_ROOMS_TOKEN: config.bearerToken },
  })
  const sessionId = findSessionId(result.body.stdout ?? "")
  if (sessionId !== undefined) writeSession(wake.roomId, wake.agentId, sessionId)
  return result
})
