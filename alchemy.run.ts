import * as Alchemy from "alchemy"
import { localState } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"
import Api from "./src/api-worker.ts"

const state = process.env.AGENT_ROOMS_LOCAL_STATE === "1" ? localState() : Cloudflare.state()

export default Alchemy.Stack(
  "AgentRooms",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const api = yield* Api
    return { url: api.url }
  }),
)
