---
name: traces
description: Debug a deployed agent-rooms stage from Alchemy and Worker logs instead of guessing.
---

# Traces

Local `alchemy dev` logs are not proof of a deployed Worker. For a real stage:

1. `bun run deploy` with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` set.
2. Read the Alchemy deploy output and the Worker logs for the stage named in the command.
3. Wake delivery is at-least-once. A duplicate webhook is a retry, not a second logical message.
