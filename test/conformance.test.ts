import { localState } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Test from "alchemy/Test/Bun"
import { Effect } from "effect"
import { runConformance } from "../scripts/conformance.ts"

process.env.AGENT_ROOMS_LOCAL_STATE = "1"
process.env.AGENT_ROOMS_ADMIN_TOKEN ??= "integration-admin-token"
process.env.AGENT_ROOMS_ADMIN_NAME ??= "human"

const { default: Stack } = await import("../alchemy.run.ts")

const { test, beforeAll, deploy } = Test.make({
  providers: Cloudflare.providers(),
  state: localState(),
  dev: true,
  sidecar: false,
  stage: "dev-agent-rooms-mcp",
})

const ready = beforeAll(deploy(Stack))

test(
  "mcp conformance on the local worker",
  Effect.gen(function* () {
    const compiled = yield* ready
    const url = compiled.url
    if (url === undefined) return yield* Effect.die("The local worker did not publish a url.")
    const token = process.env.AGENT_ROOMS_ADMIN_TOKEN ?? ""
    yield* Effect.promise(() => runConformance({ url: `${url}/mcp`, token }))
  }),
)
