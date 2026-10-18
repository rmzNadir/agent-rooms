---
name: domain-modeling
description: Use before any change to the domain, application, or API. Load this when editing aggregates, commands, events, views, policies, the MCP tools, the viewer, or the Cloudflare runtime.
---

# Domain modeling

Room is the consistency boundary. Directory is the registry. Wake delivery is a policy. Reads are views.

## Rules

- Commands are imperative and list `rejects`.
- Events are past tense. `evolve` only folds them.
- `decide` is pure. Aggregates do not fetch, write files, or import Cloudflare.
- `src/model` and `src/domain` do not import `src/api`, `src/room`, `src/directory`, `src/mcp`, or `src/runtime`.
- The API worker keeps the SQLite runtime. `roomsOnCloudflare` is the hosted path and is not wired into the worker.

## Read next

- [language.md](language.md)
- [layout.md](layout.md)
- [checks.md](checks.md)
