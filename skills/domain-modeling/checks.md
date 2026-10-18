# Checks

`scripts/architecture.ts` fails the build when:

- a domain file imports infrastructure, HTTP, or Cloudflare
- a command class omits `rejects`
- an event name is not past tense
- a command name is not imperative
- `CLAUDE.md` is not the same text as `AGENTS.md`, or git does not record it as a symlink
- a harness copy of the skill differs from `skills/domain-modeling`
- the API worker imports `roomsOnCloudflare`

`bun run check` runs this before coverage. Story tests live in `test/room-model.test.ts` and `test/directory-model.test.ts`.
