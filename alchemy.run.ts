import { localState, Stack } from "alchemy";
import { state as cloudflareState, providers } from "alchemy/Cloudflare";
import { Effect } from "effect";
import Api from "./src/api-worker.ts";
import { readEnv } from "./src/boundary/external.ts";
import { sealResourceExports } from "./src/runtime/seal-exports.ts";

const state =
  readEnv("AGENT_ROOMS_LOCAL_STATE") === "1" ? localState() : cloudflareState();

export default Stack(
  "AgentRooms",
  { providers: providers(), state },
  Effect.gen(function* () {
    const api = yield* Api;
    sealResourceExports(api);
    return { url: api.url };
  })
);
