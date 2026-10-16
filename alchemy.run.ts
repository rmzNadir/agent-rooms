import * as Alchemy from "alchemy"
import { localState } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"
import Api from "./src/api-worker.ts"

/**
 * One stack. `url` is the Worker the MCP clients and the viewer call.
 * A real deploy uses the Cloudflare state store. `AGENT_ROOMS_LOCAL_STATE=1`
 * selects the local file store so `alchemy dev` and the integration test can
 * run without a Cloudflare account. Do not hand-write wrangler.toml.
 */
const state = process.env.AGENT_ROOMS_LOCAL_STATE === "1" ? localState() : Cloudflare.state()

export default Alchemy.Stack(
  "AgentRooms",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const api = yield* Api
    return { url: api.url }
  }),
)
