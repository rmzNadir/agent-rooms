import {
  codexArgs,
  rememberSession,
  sessionFor,
  spawnHarness,
} from "./listener-io.mjs";
import { serve } from "./listener-wake.mjs";

serve(async (wake, config, prompt) => {
  const result = await spawnHarness({
    args: codexArgs(
      config.codexExtraArgs,
      sessionFor(wake.roomId, wake.agentId),
      prompt
    ),
    bin: config.codexBin,
    cwd: config.workdir,
    env: { AGENT_ROOMS_TOKEN: config.bearerToken },
  });
  return rememberSession(wake, result);
});
