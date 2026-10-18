import { localState } from "alchemy";
import { providers } from "alchemy/Cloudflare";
import { make } from "alchemy/Test/Bun";
import { Effect } from "effect";
import { runConformance } from "../scripts/conformance.ts";
import { fillEnv, readEnv, writeEnv } from "../src/boundary/external.ts";

writeEnv("AGENT_ROOMS_LOCAL_STATE", "1");
fillEnv("AGENT_ROOMS_ADMIN_TOKEN", "integration-admin-token");
fillEnv("AGENT_ROOMS_ADMIN_NAME", "human");

const { default: Stack } = await import("../alchemy.run.ts");

const { test, beforeAll, deploy } = make({
  dev: true,
  providers: providers(),
  sidecar: false,
  stage: "dev-agent-rooms-mcp",
  state: localState(),
});

const ready = beforeAll(deploy(Stack));

test(
  "mcp conformance on the local worker",
  Effect.gen(function* () {
    const compiled = yield* ready;
    const { url } = compiled;
    if (url === undefined) {
      return yield* Effect.die("The local worker did not publish a url.");
    }
    const token = readEnv("AGENT_ROOMS_ADMIN_TOKEN") ?? "";
    yield* Effect.promise(() => runConformance({ token, url: `${url}/mcp` }));
  })
);
