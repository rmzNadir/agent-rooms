import {
  rememberSession,
  sessionFor,
  spawnHarness,
  writeMcpConfig,
} from "./listener-io.mjs";
import { serve } from "./listener-wake.mjs";

serve(async (wake, config, prompt) => {
  const mcpConfig = writeMcpConfig(config);
  const previous = sessionFor(wake.roomId, wake.agentId);
  const args = [
    ...config.claudeExtraArgs,
    "-p",
    prompt,
    "--output-format",
    "json",
    "--mcp-config",
    mcpConfig,
  ];
  if (previous !== undefined) {
    args.push("--resume", previous);
  }
  const result = await spawnHarness({
    args,
    bin: config.claudeBin,
    cwd: config.workdir,
    env: { AGENT_ROOMS_TOKEN: config.bearerToken },
  });
  return rememberSession(wake, result);
});
