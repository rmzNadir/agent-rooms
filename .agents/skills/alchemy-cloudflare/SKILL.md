---
name: alchemy-cloudflare
description: Look up Alchemy v2 Cloudflare resources from the installed source and the v2 docs, one page at a time.
---

# Alchemy on Cloudflare

1. Read `node_modules/alchemy` for the resource you are about to call. Published types live in `lib/*.d.ts`; the `bun` condition points at `src`.
2. Open https://v2.alchemy.run/llms.txt and fetch one page. Do not pull the full dump.
3. Declare Workers and Durable Objects in `alchemy.run.ts`. Do not hand-write `wrangler.toml` or migrations.
4. Stub HTTP clients are built per invocation with `makeExecutionMemo` from `alchemy/Runtime/ExecutionMemo`.
