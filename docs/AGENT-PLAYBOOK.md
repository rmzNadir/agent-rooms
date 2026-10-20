# Agent playbook

Researched 2026-10-16 from Dillon Mulroy's Effect and Alchemy notes, opencode,
and the Alchemy docs. Sources are at the end. Effect 4 and Alchemy v2 are
pre-1.0 and differ from what models learned in training.

This file is research. The rules for this repository are `AGENTS.md`,
`docs/coding-standards.md`, and `docs/errors.md`.

## This repository

Stage `nadir` deploys only from the GitHub Actions workflow `Deploy nadir`.
Secrets live in the GitHub Environment `nadir`. Nothing for that stage is
kept on a local machine. Room backups go to the private R2 bucket
`agent-rooms-nadir-backups`. The procedure is `docs/DEPLOY-NOTES.md`.

This repo is one Bun package. `alchemy.run.ts` is the only infrastructure
entry. `src/model` is the domain. `src/domain` holds the shared schemas.
`src/api` is the MCP and viewer. Tests live under `test/`. `bun run check`
is the done gate. Integration tests use a local Alchemy stage (`dev: true`).
That local result is the integration gate. It does not deploy stage `nadir`.

Before writing code against Effect or Alchemy, read the installed source
under `node_modules/effect` and `node_modules/alchemy`.

## 0. The source idea

Dillon's note on 2026-10-14 was that he carries two long docs from project
to project, `docs/coding-standards.md` and `docs/errors.md`, and keeps
`AGENTS.md` short:

- <https://x.com/dillon_mulroy/status/2110412260875342323>
- <https://github.com/dmmulroy/cf-workflow-pool/blob/main/docs/coding-standards.md>
- <https://github.com/dmmulroy/cf-workflow-pool/blob/main/docs/errors.md>

His loop was to deploy to Cloudflare with Alchemy, read the traces, and fix
(<https://x.com/dillon_mulroy/status/2108684370626195819>). This repository
does not deploy stage `nadir` from a laptop to get that loop. A stage
`nadir` deploy runs in GitHub Actions. Traces for that deployed Worker are
still the signal when a run has completed.

## 1. Source layout (cf-workflow-pool)

The layout below is Dillon's monorepo. It is not this repository.

```text
AGENTS.md
docs/coding-standards.md
docs/errors.md
.agents/skills/<name>/SKILL.md
apps/<app>/alchemy.run.ts
apps/<app>/src/*.ts
packages/*
pnpm-workspace.yaml
```

That repo's done gate is `vp check` and a recursive test run, with per-app
`deploy:<stage>` scripts. opencode uses `bun run check` at the root and asks
agents to read `.opencode/skills` before tests
(<https://github.com/sst/opencode/blob/dev/AGENTS.md>).

## 2. What belongs in AGENTS.md

The pattern from cf-workflow-pool:

1. Project thesis and vocabulary.
2. The drift warning: Effect 4 and Alchemy v2 are pre-1.0. Read
   `node_modules/effect` and `node_modules/alchemy` before writing against
   either.
3. Read `docs/coding-standards.md` before writing or reviewing code. Read
   `docs/errors.md` before changing typed errors.
4. What counts as evidence. In this repository, `bun run check` and the
   local integration stage are the gates. Stage `nadir` is deployed only by
   the `Deploy nadir` workflow.
5. Traces for a deployed stage, when one exists.

This repository's short file is `AGENTS.md` at the root. An older local
draft described a `RoomServer` HttpApi, pnpm, and MCP tools named
`rooms.create`. That draft does not match the domain model or the checks.

## 3. Docs to read

| Source | How |
| --- | --- |
| Installed source | `node_modules/effect/` and `node_modules/alchemy/`. First stop. |
| Effect v4 | <https://effect.website/docs/v4/llms.txt> |
| Effect Solutions | `bunx effect-solutions@latest list` and `show <topic>` |
| Alchemy v2 | <https://v2.alchemy.run/llms.txt>. One page. Skip the full dump. |
| Alchemy examples | `alchemy-run/alchemy-effect` examples and that repo's `AGENTS.md` |
| This repo | `docs/coding-standards.md`, `docs/errors.md`, `skills/domain-modeling/SKILL.md` |

Alchemy pages that mattered in the 2026-10-16 pass: Workers, Durable
Objects, hibernatable WebSockets, Effect RPC, and the RPC Durable Object
tutorial. The community Effect docs MCP was not verified in that pass.

## 4. Checks in this repository

1. `bun run check` is the typecheck, Biome, and the strictness gates,
   including mutation of `src/**/*.ts`.
2. `bun run test:conformance` and `bun run test:integration` deploy a local
   Alchemy stage. Those results are the integration evidence. They do not
   deploy stage `nadir`.
3. Bound every retry. The wake policy stops after 8 attempts.
4. When a GitHub Actions deploy of stage `nadir` has run, debug that stage
   from its logs. Do not guess.

## 5. Effect style

The long form is `docs/coding-standards.md` and `docs/errors.md`. The
2026-10-16 summary:

- Import `Effect`, `Layer`, `Schema`, and `Context` from `"effect"`.
  Unstable HTTP modules come from `effect/unstable/http`. Alchemy uses
  `import * as Alchemy from "alchemy"` and
  `import * as Cloudflare from "alchemy/Cloudflare"`.
- Business logic goes in `Effect.gen` or `Effect.fn`. Retry, timeout,
  spans, and provision go in `.pipe` or as `Effect.fn` transforms.
- A service is a `Context.Service`. Its constructor stays in that module.
  Consumers `yield*` the service. Dependencies stay in the Layer channel
  until the composition root.
- Decode at the adapter boundary into branded types. Pass typed values
  inward.
- Tagged errors carry the operation, safe ids, a reason, and whether the
  call can be retried. Translate with `Effect.catchTags` and list every
  tag. Public failures use `{ code, message, details, requestId, retryable }`
  and never include SQL, stack traces, tokens, or webhook secrets.
- Do not use `any`.

## 6. Durable Objects

Address an instance by its canonical room id, not a display name. Declare
Workers and Durable Objects in `alchemy.run.ts`. Do not hand-write
`wrangler.toml` or Durable Object migrations.

The 2026-10-16 notes described each Durable Object as its own Effect
`HttpApi` on `fetch`, with a client that is the only module allowed to
touch the namespace. This repository hosts the room model from the Worker.
The domain rules are `skills/domain-modeling/SKILL.md`. Stub clients, when
used, are built per invocation.

Alchemy's own docs also show a schemaless method bridge. This repository
uses the Domain host in `alchemy.run.ts`, not a hand-written RPC client.

Stage `nadir` is the shared stage. It is not destroyed from a laptop, and
its secrets are not written to an env file on disk.

## 7. Narrow skills

Keep few. This repo already has `skills/domain-modeling` and
`.agents/skills/alchemy-cloudflare` (read installed Alchemy source, fetch
one v2 docs page, declare resources in `alchemy.run.ts`).

## Sources

- <https://github.com/dmmulroy/cf-workflow-pool>
- <https://x.com/dillon_mulroy/status/2110412260875342323>
- <https://x.com/dillon_mulroy/status/2108684370626195819>
- <https://x.com/dillon_mulroy/status/2110391826951831917>
- <https://github.com/sst/opencode/blob/dev/AGENTS.md>
- <https://github.com/alchemy-run/alchemy-effect/blob/main/AGENTS.md>
- <https://v2.alchemy.run/llms.txt>
- <https://effect.website/llms.txt>
- <https://effect.website/docs/v4/llms.txt>
- <https://www.effect.solutions>
