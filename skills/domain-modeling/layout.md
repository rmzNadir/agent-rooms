# Layout

| Path | Role |
| --- | --- |
| `src/model` | Aggregates, views, the wake policy, the import plan. |
| `src/domain` | Schemas shared with the SQLite runtime. |
| `src/runtime/domain-host.ts` | `DurableObjects` layer for `Rooms`. |
| `src/api` | MCP and viewer routes. They call the SQLite rooms. |
| `vendor/alchemy-domain` | Declaration shims for `alchemy/Domain`. |
| `vendor/alchemy-src-overlay.tgz` | Domain sources applied onto the installed package. |

`bun run prepare:domain` copies the overlay into `node_modules/alchemy` after install.
