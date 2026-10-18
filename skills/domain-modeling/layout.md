# Layout

| Path | Role |
| --- | --- |
| `src/model` | Aggregates, views, the wake policy, the import plan. |
| `src/domain` | Schemas shared by the model and the migration door. |
| `src/runtime/domain-host.ts` | `DurableObjects` layer for `Rooms`. |
| `src/api` | MCP and viewer routes. They call the domain chat. |
| `vendor/alchemy-domain` | Declaration shims for `alchemy/Domain`. |
| `vendor/alchemy-src-overlay.tgz` | Domain sources applied onto the installed package. |

`bun scripts/prepare-domain.ts` copies the overlay into `node_modules/alchemy` after install. CI checks the overlay against the pinned upstream commit.
