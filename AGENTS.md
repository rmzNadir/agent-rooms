# Agent Instructions: agent-rooms

## Project
`agent-rooms` is an MCP chat server on Cloudflare. A Worker exposes an MCP endpoint (Streamable HTTP) plus WebSocket upgrade. Each **Room** is a Durable Object (`RoomServer`) keyed by its branded `RoomId`. It owns membership, ordered message history (DO SQLite), and live fan-out over hibernatable WebSockets. MCP tools (`rooms.create`, `rooms.join`, `rooms.post`, `rooms.history`, `rooms.leave`) let agents talk to each other through rooms.

Vocabulary: **Room** (a DO instance), **Member** (an agent/human identity in a room), **Message** (an immutable, sequenced entry), **Cursor** (the last seen sequence number).

## Stack
Cloudflare Workers + Durable Objects, Effect 4 (`effect` 4.x), Alchemy v2 (Effect-native, `alchemy`), pnpm, TypeScript strict. **Effect 4 and Alchemy v2 are pre-1.0 and differ from your training data.** Before writing code against either, read the installed source and docs under `node_modules/effect` and `node_modules/alchemy`. Then use:
- Alchemy docs index: https://v2.alchemy.run/llms.txt (pick one page; don't fetch llms-full.txt unless you need a specific resource reference). Relevant pages: Workers, Durable Objects, Hibernatable WebSockets, Effect RPC/HttpApi.
- Effect v4 docs: https://effect.website/docs/v4/llms.txt
- Patterns: `bunx effect-solutions@latest list` / `show <topic>`
Never guess an API. If it isn't in node_modules or those docs, say so.

## Layout
```
alchemy.run.ts            # Alchemy.Stack("AgentRooms") — only composition root for infra
src/api-worker.ts         # Cloudflare.Worker: MCP + WS routing, composition root for runtime Layers
src/mcp/*.ts              # MCP protocol adapter (decode JSON-RPC with Schema, map tools → RoomClient)
src/room/room-server.ts   # Cloudflare.DurableObject RoomServer: Effect HttpApi on fetch (/v1/...) + WS
src/room/room-client.ts   # RoomClient service (IRoomClient); only module that touches the DO namespace/stubs
src/room/room-http-api.ts # HttpApi contract + schemas + tagged errors
src/domain/*.ts           # branded IDs, Message/Member schemas, pure logic
test/*.test.ts            # Alchemy Test.make integration tests against a deployed stage
docs/coding-standards.md  # long-form rules — READ before writing or reviewing code
docs/errors.md            # error doctrine — READ before touching errors
```
(Seed docs/coding-standards.md and docs/errors.md from https://github.com/dmmulroy/cf-workflow-pool/tree/main/docs and adapt the examples.)

## Project standards
- Read `docs/coding-standards.md` before writing or reviewing code. Review finished code against it before you call work complete.
- Read `docs/errors.md` before adding or changing typed errors, error messages, HTTP statuses, or retry guidance.

## Effect rules (summary; full rules in docs)
- Imports: `import { Effect, Layer, Schema, Context, Option } from "effect"`. Unstable: `import { HttpApi, HttpServerResponse } from "effect/unstable/http"`. No `import * as X from "effect/X"`. Alchemy: `import * as Alchemy from "alchemy"`, `import * as Cloudflare from "alchemy/Cloudflare"`.
- Business logic goes in `Effect.gen` / `Effect.fn("Service.op")(function* …)`. Retry, timeout, spans, error translation, and provision go in `.pipe` or as `Effect.fn` transforms.
- Services: `class RoomClient extends Context.Service<RoomClient, IRoomClient>()("@agent-rooms/RoomClient") {}`. `makeRoomClient` is only used inside its own module, which exports the Layers. Consumers `yield* RoomClient`. Dependencies stay in the Layer requirement channel until the composition root. Bind each service to a name before calling it.
- Schema: decode `unknown` once at the adapter boundary (MCP JSON-RPC, WS frames, DO storage rows, env) into branded types. Pass typed values inward. No casts, no repeated validation, no raw `JSON.parse` (use `Schema.UnknownFromJsonString`).
- Errors: `Schema.TaggedError` carrying `operation`, safe IDs, a `reason` literal, and `retryable`. Translate with `Effect.catchTags` and list every tag. No catch-all, no broad `mapError`, no `instanceof`. Map public errors to MCP/HTTP as `{code, message, details, requestId, retryable}`. Never leak stack traces, SQL, or DO internals.
- No `any`. Prefer `const` and early returns. No try/catch in Effect code. No single-use helpers. No speculative abstractions.

## Durable Object rules
- `RoomServer` is an independent HTTP service: an Effect `HttpApi` served on its `fetch`, with routes versioned `/v1/...`. Don't use typed Alchemy RPC.
- Only `room-client.ts` touches the namespace, stubs, or `Cloudflare.toHttpClient`. Build stub clients per invocation (`makeExecutionMemo` + `Cache` keyed by `RoomId`). Never keep one across requests.
- Address instances only by canonical `RoomId` (`getByName(roomId)`), never by a display name.
- Use the hibernatable WebSocket API (see the alchemy guide). Keep per-connection state in the WS attachment, not in memory.
- Message ordering: the DO assigns a monotonically increasing `seq` inside a storage transaction.

## Infra (alchemy.run.ts)
- One Stack, `Alchemy.Stack("AgentRooms", { providers: Cloudflare.providers(), state: Cloudflare.state() }, …)`. It returns `{ url }`.
- The Worker yields `RoomServer` during init, which registers the DO binding and exports. Never hand-write wrangler.toml or DO migrations.
- Non-prod stages use generated or stage-qualified names and must be destroyable. Use stage `dev-<name>` for your own iteration.

## Checks (definition of done)
1. `pnpm typecheck` (or `vp check`). Don't run raw `tsc` ad hoc.
2. `timeout 240 pnpm test`. Unit tests use real Layers or faithful `Layer.succeed` test Layers, no mocks, no `globalThis`.
3. Integration: `test/*.test.ts` with `Test.make({ providers: Cloudflare.providers(), state: Cloudflare.state() })` + `beforeAll(deploy(Stack))`. Exercise MCP tools and WS fan-out against the **deployed** Worker. Local workerd results don't count as proof.
4. Bound every `Effect.retry` (≤8 attempts, <60s total). If a suite is still red after 3 fix iterations on a platform issue, stop and report the exact error.
5. Debug from logs and traces for the stage (`alchemy` logs / OTel), not guesses.

## Git
Branch names are at most three hyphenated words (no `feat/`). Commits use `type(scope): summary` (feat, fix, docs, chore, refactor, test). Before adding complexity for an unlikely race or security edge case, describe the failure mode, how likely it is, and what it costs, and ask first.
