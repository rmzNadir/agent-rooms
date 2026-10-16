import { Effect, Schema } from "effect"

const usage = `Usage:
  AGENT_ROOMS_URL=https://worker AGENT_ROOMS_ADMIN_TOKEN=... bun scripts/agents.ts create --name ada [--kind agent|human] [--webhook https://listener]
  AGENT_ROOMS_URL=... AGENT_ROOMS_ADMIN_TOKEN=... bun scripts/agents.ts list
  AGENT_ROOMS_URL=... AGENT_ROOMS_ADMIN_TOKEN=... bun scripts/agents.ts rotate --id agent_...
  AGENT_ROOMS_URL=... AGENT_ROOMS_TOKEN=<agent token> bun scripts/agents.ts webhook --id agent_... --url https://listener

create prints the bearer token and webhook secret once. webhook authenticates as that agent, and --id must be that agent.
`

const flag = (name: string) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const Created = Schema.Struct({
  agent: Schema.Struct({
    agentId: Schema.String,
    displayName: Schema.String,
    kind: Schema.String,
    admin: Schema.Boolean,
  }),
  token: Schema.String,
  webhookSecret: Schema.String,
})

const decodeCreated = Schema.decodeEffect(Schema.fromJsonString(Created))

const request = (path: string, method: string, token: string, body?: unknown) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${process.env.AGENT_ROOMS_URL ?? ""}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { ok: response.ok, text: await response.text() }
    },
    catch: (cause) => cause,
  }).pipe(Effect.orDie)

const program = Effect.gen(function* () {
  const command = process.argv[2]
  const root = process.env.AGENT_ROOMS_URL ?? ""
  const admin = process.env.AGENT_ROOMS_ADMIN_TOKEN ?? ""
  if (root.length === 0 || command === undefined || command === "help") {
    console.log(usage)
    return
  }
  if (command === "create") {
    const name = flag("--name")
    if (admin.length === 0 || name === undefined) return yield* Effect.die(usage)
    const created = yield* request("/admin/agents", "POST", admin, {
      displayName: name,
      kind: flag("--kind") ?? "agent",
      webhookUrl: flag("--webhook") ?? null,
    })
    if (!created.ok) return yield* Effect.die(created.text)
    const agent = yield* Effect.catchTag(decodeCreated(created.text), "SchemaError", () => Effect.die(created.text))
    console.log(JSON.stringify(agent, null, 2))
    console.log("Store the token and webhook secret now. They are not shown again.")
    return
  }
  if (command === "list") {
    const listed = yield* request("/admin/agents", "GET", admin)
    if (!listed.ok) return yield* Effect.die(listed.text)
    console.log(listed.text)
    return
  }
  if (command === "rotate") {
    const id = flag("--id")
    if (id === undefined || admin.length === 0) return yield* Effect.die(usage)
    const rotated = yield* request(`/admin/agents/${id}/rotate`, "POST", admin, {})
    if (!rotated.ok) return yield* Effect.die(rotated.text)
    console.log(rotated.text)
    return
  }
  if (command === "webhook") {
    const id = flag("--id")
    const url = flag("--url")
    const token = process.env.AGENT_ROOMS_TOKEN ?? ""
    if (id === undefined || url === undefined || token.length === 0) return yield* Effect.die(usage)
    const updated = yield* request(`/admin/agents/${id}/webhook`, "POST", token, { webhookUrl: url })
    if (!updated.ok) return yield* Effect.die(updated.text)
    console.log(updated.text)
    return
  }
  console.log(usage)
})

Effect.runPromise(program).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : error
  console.error(message)
  process.exit(1)
})
