# Agent Rooms

Domain rules live in the skill. Load `skills/domain-modeling/SKILL.md` before any code change.

## Before writing

Effect 4 and Alchemy v2 are pre-1.0 and drift from training data. Before writing code against either, read the installed source under `node_modules/effect` and `node_modules/alchemy`. Alchemy pages are indexed at <https://v2.alchemy.run/llms.txt>. Fetch one page. Effect v4 docs are indexed at <https://effect.website/docs/v4/llms.txt>.

Read `docs/coding-standards.md` before writing or reviewing code, and review finished code against it. Read `docs/errors.md` before adding or changing typed errors, HTTP statuses, or retry guidance. Public failures use `{ code, message, details, requestId, retryable }`. They never include SQL, stack traces, tokens, or webhook secrets.

Address a Durable Object by its canonical room id, not a display name. Declare Workers and Durable Objects in `alchemy.run.ts`. Do not hand-write `wrangler.toml` or Durable Object migrations. Do not use `any`. Bound every retry.

## Language

A **Room** is the consistency boundary for members, messages, pause, and the hop count. A **Member** is an agent or a human. One member is the **lead**. An **Agent** is registered in the **Directory**. A **Message** has a seq. A **Mention** is required when an agent posts and other members are present. A **Thread** is the message a reply targets. A **Wake** is a webhook delivery. A **Cursor** is a member's last read seq. The **HopLimit** is eight. **Pause** stops posts until the lead resumes.

Commands are imperative and name their rejections. Events are past tense. `decide` returns events or a rejection. `evolve` folds events. Views serve transcript, unread, and search. The wake policy retries delivery and expires it at the deadline.

## Layout

`src/model` is the domain. `src/domain` holds the shared schemas. `src/api` is the MCP and viewer. The worker hosts that model on Cloudflare Durable Objects. Existing SQLite rows are imported on first access of each object, then the legacy runtime is gone.

## Checks

`bun run check` runs `scripts/architecture.ts` plus the strictness gates. The import plan is `importPlan` in `src/model/migrate.ts`. It copies directory and room rows into events and keeps token hashes beside the stream. Production deploys from the GitHub Actions workflow `Deploy`. The stage, GitHub Environment, and backup bucket come from repository variables. Secrets for that stage live in the named GitHub Environment, and nothing for the stage is kept on a local machine. The workflow backs rooms up to that private R2 bucket before the deploy and rolls the Worker back when that backup does not match. A rollback cannot cross a Durable Object migration; restore that case from the R2 backup.
