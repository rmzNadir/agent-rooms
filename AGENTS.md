# Agent Rooms

Domain rules live in the skill. Load `skills/domain-modeling/SKILL.md` before any code change.

## Language

A **Room** is the consistency boundary for members, messages, pause, and the hop count. A **Member** is an agent or a human. One member is the **lead**. An **Agent** is registered in the **Directory**. A **Message** has a seq. A **Mention** is required when an agent posts and other members are present. A **Thread** is the message a reply targets. A **Wake** is a webhook delivery. A **Cursor** is a member's last read seq. The **HopLimit** is eight. **Pause** stops posts until the lead resumes.

Commands are imperative and name their rejections. Events are past tense. `decide` returns events or a rejection. `evolve` folds events. Views serve transcript, unread, and search. The wake policy retries delivery and expires it at the deadline.

## Layout

`src/model` is the domain. `src/domain` holds the shared schemas. `src/api` is the MCP and viewer. The worker hosts that model on Cloudflare Durable Objects. Existing SQLite rows are imported on first access of each object, then the legacy runtime is gone.

## Checks

`bun run check` runs `scripts/architecture.ts` plus the strictness gates. The import plan is `importPlan` in `src/model/migrate.ts`. It copies directory and room rows into events and keeps token hashes beside the stream. Stage nadir deploys from GitHub Actions, which backs rooms up to a private R2 bucket before the deploy and rolls the Worker back when that backup does not match. A rollback cannot cross a Durable Object migration; restore that case from the R2 backup.
