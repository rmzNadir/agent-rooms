# Stage rename plan

Planning only. This document does not deploy, does not change Cloudflare, and does not change GitHub variables, environments, or secrets. [PR #4](https://github.com/rmzNadir/agent-rooms/pull/4) stays unmerged until Diego merges it.

## Order

Land PR #4 first, with the four repository variables still set to the current production profile (`nadir`, environment `nadir`, bucket `agent-rooms-nadir-backups`, verify list `brobert,codex`). Prove one ordinary deploy still updates the existing Worker. Only then change the stage.

PR #4 removes the stage, the GitHub Environment, and the bucket from the workflow. After it, a rename is an operator cutover plus one small code change that pins the existing script name. Doing the rename before that PR means editing the hardcoded `nadir` workflow and the variable model in the same push. A push to `main` would deploy whatever those values are. The safer sequence is parameterize, prove, then rename.

This document can merge on its own. The migration steps below assume PR #4 is already on `main`.

## Proposed names

| Thing | Proposed value | Why |
| --- | --- | --- |
| Alchemy stage | `prod` | Matches the profile pattern `^[a-z][a-z0-9-]{0,40}$` in `scripts/deploy-profile.ts` on PR #4. It is not a person's handle. Alchemy's own default stage is `live_$USER` (`node_modules/alchemy/src/Cli/commands/flags.ts`), so `live` is a poor production name. |
| GitHub Environment | `prod` | The workflow selects `environment:` from `AGENT_ROOMS_GITHUB_ENVIRONMENT`. The pair should match. |
| Worker script | the script that exists today | Cloudflare does not rename a Worker. The public `workers.dev` host is that script name. Keeping it keeps every client URL working through the stage change. |
| Hostname, later | `rooms.ce.systems` | A custom domain on the zone `ce.systems`, so a later script move does not change the URL clients store. |
| R2 bucket | keep `agent-rooms-nadir-backups` | R2 buckets cannot be renamed. The objects are the restore copy. |

`prod` is one production stage. A second stage would be a second Worker and empty Durable Object storage.

## 1. What a new stage creates, and how to keep the data

`alchemy.run.ts` builds stack `AgentRooms`. State is the remote `alchemy-state-store` Worker unless `AGENT_ROOMS_LOCAL_STATE=1`. That store is one per account. Stages are rows inside it, keyed by stack name plus stage. A new stage does not create a second state store.

`src/api-worker.ts` declares logical id `Api` and does not set `WorkerProps.name`. `createWorkerName` in `node_modules/alchemy/src/Cloudflare/Workers/WorkerName.ts` then calls `createPhysicalName` and lowercases the result. The prefix is `${stack}-${id}-${stage}-` plus a 16-character base32 suffix of a new instance id (`node_modules/alchemy/src/PhysicalName.ts`). For stage `prod` the script name is `agentrooms-api-prod-` plus that suffix. It is not knowable before the first deploy. The script is tagged `alchemy:stack:AgentRooms`, `alchemy:stage:prod`, and `alchemy:id:Api`.

`workersDev` defaults to true, so the public URL is `https://<script>.<account-subdomain>.workers.dev`. Alchemy's `worker.url` is that host until a custom domain is attached. Durable Object classes on that script get new SQLite namespaces. Binding names are the class names. The classes hosted today are the legacy doors `DirectoryServer` and `RoomServer` (`src/runtime/legacy-door.ts`) and the domain classes `roomsOnCloudflare` declares through `node_modules/alchemy/src/Domain/Cloudflare.ts`. That file names each class `${aggregateName}Aggregate`, `${viewName}View`, `${policyName}Policy`, `${projectionName}Projection`, and `${streamName}Stream`. With the model in `src/model`, those classes are `DirectoryAggregate`, `RoomAggregate`, `TranscriptView`, `UnreadView`, `SearchIndexView`, `WakeDeliveryPolicy`, `TranscriptLinesProjection`, and `TranscriptLogStream`. A new script means new namespace ids and empty storage.

### Adoption keeps the storage. Recreate does not.

Two Alchemy mechanisms were checked in `2.0.0-beta.83`.

**Pin the script name and adopt it.** `createWorkerName` uses an explicit `name` when one is set. `Worker.read` treats a script as owned only when its tags contain this stack, this stage, and this logical id (`hasAlchemyWorkerTags` in `WorkerProvider.ts`). The live script is tagged `alchemy:stage:nadir`. A deploy of stage `prod` that sets `name` to that same script does not see its own tags, so the read is `Unowned`. `alchemy deploy --adopt --stage prod` then takes the script over and rewrites the tags to `alchemy:stage:prod`. The adopting-deploy note in `DurableObject.ts` says existing classes are reused in place when `className` matches. Storage stays. This is the path to use.

The repo does not set `name` today. The cutover needs a follow-up change, after PR #4, that sets the Worker `name` from an environment value for that one production deploy and leaves local `alchemy dev` unnamed. The value is the first label of the current `AGENT_ROOMS_URL` when that host is `workers.dev` (`scriptNameFromUrl` in `scripts/snapshot-diff.ts`).

**`transferredFrom` is the other mechanism, and it is the wrong one here.** `DurableObject.ts` can move a class onto a new script and keep its data, but only when the new host declares `transferredFrom` with the old physical script name. The domain classes are constructed by `alchemy/Domain/Cloudflare`'s `DurableObjects` layer. That layer does not expose `transferredFrom` (it is absent under `node_modules/alchemy/src/Domain`). Declaring it only on `DirectoryServer` and `RoomServer` would move the legacy doors and leave the model classes empty. A new script also means a new URL.

`--adopt` without a pinned `name` does not attach stage `prod` to the old script. It would adopt some other conflicting resource or create `agentrooms-api-prod-<suffix>`.

### After adoption, do not destroy stage `nadir`

`alchemy destroy --stage nadir` deletes the resources recorded in that stage's state. If that record still points at the adopted script, destroy deletes the script and the Durable Object storage. Zones default to retain. Workers do not. The old stage row has to stay until a destroy plan is read and Diego confirms it does not delete the live script. `alchemy destroy` accepts `--dry-run`. Run that, read it, and stop. Deleting the Worker is a later step, and only after that plan shows the live script is not a target.

A second deploy of stage `nadir` after the tags have been rewritten would also fight stage `prod` for the same script. Retire the `nadir` variables in the same cutover so the workflow cannot select that stage.

## 2. What the R2 backup can and cannot restore

Prefer adoption, so this section is the fallback if an `alchemy plan --stage prod` with the pinned name shows a create instead of an update. Stop if it shows a create. Do not deploy that plan.

The backup writer is `scripts/deploy-guard.ts` `runBackup`. It calls `readBackup` in `scripts/room-read.ts`, which uses the admin MCP tools `list_rooms`, `members`, and `read_transcript`, plus `GET /admin/agents`. The stored shape is `RoomBackup` version 1 in `scripts/snapshot-diff.ts`:

- `agents`: `admin`, `agentId`, `displayName`, `kind` (`agentSnap` in `scripts/room-parse.ts`)
- `rooms`: id, name, topic, lead, members (`agentId`, `displayName`, `kind`, `role`, `joined`, `lastReadSeq`), and the transcript text

There is no `tokenHash`, no webhook URL, and no webhook secret in that JSON. Message bodies are in the transcript. Secrets are not.

`importPlan` in `src/model/migrate.ts` is a different path. It replays a `LegacyDirectory` into an empty event log. That input requires `tokenHash` on every agent and `webhookSecret` plus `webhookUrl` on every member. The rule in that file is to replay only when the log is empty. The runtime calls it once, from the legacy SQLite tables inside the existing Durable Objects (`src/runtime/legacy-door.ts`), not from an R2 object. Nothing in `scripts/` reads a backup object back into the model.

Tokens are SHA-256 hashed at rest (`hashToken` in `src/domain/token.ts`). The plaintext is returned once from create and rotate. Webhook secrets are returned once from create. The Directory matches a bearer by comparing hashes (`src/app/directory-chat.ts`). Restoring the public backup without those hashes means every existing bearer fails whoami. Listeners fail HMAC because the signing secret would be a newly minted one.

A real restore would be a new command, not a reuse of `importPlan` as it stands:

1. An export, taken from the live Directory and Room objects before cutover, that includes the token hashes and the webhook secrets and URLs. It must not print those values. The R2 object from today's backup is the public half only.
2. A decide/evolve path that can open a room and register an agent with a supplied hash and a supplied webhook secret, only when the log is empty, matching `cutoverRule`.
3. Tests for the empty-log rule, a second import that adds nobody, and a hash that still verifies the old bearer. No secret in the assertion output.
4. The same bar as the rest of the repo: Ultracite, `bun run check`, Stryker 100 on `src/**/*.ts` with zero surviving mutants, no suppressions.

That command does not exist. Building it is a domain change. Adoption avoids it, and adoption is what keeps the bearers and the webhook secrets working. On the recreate path they have to be rotated, and every listener config has to be rewritten with the new secrets.

The admin bearer is also a Worker secret, `AGENT_ROOMS_ADMIN_TOKEN`, checked against the hash stored for the human admin. Adoption rebinds the same value and the stored hash still matches. Recreate bootstraps whatever value is in the environment into an empty Directory, which is a new hash.

## 3. Custom domain on `ce.systems`

Do this after the stage adoption has been verified, as its own deploy. The zone must already exist on the account. Alchemy does not create zones. `WorkerProps.domain` (`Worker.ts`) attaches `rooms.ce.systems` and can pin `zoneName: "ce.systems"`. When `domain` is set, `worker.url` becomes `https://rooms.ce.systems` and the `workers.dev` URL stays in `worker.urls` unless `workersDev` is turned off. Leave `workersDev` on until every client has moved, so the old host still serves the same Worker.

The ongoing deploy token documented in the README does not include zone DNS edit. Attaching the hostname needs zone read and DNS edit on `ce.systems`, plus the existing Workers Scripts and R2 groups. Add those groups on a token Diego creates for that step. This plan does not create the token.

After the URL is no longer a `workers.dev` host, pin and rollback need `AGENT_ROOMS_WORKER_NAME` set to the script name. On PR #4, `workerScript` in `scripts/deploy-guard.ts` uses the first label of a `workers.dev` host and ignores the override in that case. A custom host uses the override. Set the secret before changing `AGENT_ROOMS_URL`, or the next deploy cannot pin.

Access stays a second step. The README already states the two workable policies. Access is the network gate. The bearer is still the application identity.

- Protect the whole hostname and give every MCP client `CF-Access-Client-Id` and `CF-Access-Client-Secret`, or
- Bypass Access for `POST /mcp` and `/admin/*`, and require Access for `/` and `/rooms/*`.

Putting Access on in the same deploy as the hostname can lock the verify step out if the policy is wrong. Attach the hostname, run verify, then add Access. The viewer cookie `agent_rooms_token` is already `Secure` on `https://` requests.

Alchemy can also declare `access` on the Worker (`Worker.ts`). That enrolls the Worker, its custom domain, and its `workers.dev` host in one Access application. Prefer the bypass policy above so existing Claude Code, Codex, Brobert, and ChatGPT configs do not all need new Access headers on the same day.

## 4. What has to change, and what stays

Nothing in git contains the live URL. `docs/DEPLOY-NOTES.md` says the URL is the secret `AGENT_ROOMS_URL`.

Change at cutover, after the adopt plan is an update:

| Item | Change |
| --- | --- |
| Repository variable `AGENT_ROOMS_STAGE` | `prod` |
| Repository variable `AGENT_ROOMS_GITHUB_ENVIRONMENT` | `prod` |
| GitHub Environment | Create `prod`. GitHub does not rename an environment. Secret values cannot be read back, so Diego pastes each value into the new environment. |
| Secrets to paste | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `AGENT_ROOMS_ADMIN_TOKEN`, `AGENT_ROOMS_URL` (unchanged until the custom domain), `AGENT_ROOMS_BROBERT_TOKEN`, `AGENT_ROOMS_CODEX_TOKEN`. `AGENT_ROOMS_WORKER_NAME` when the host is not `workers.dev`. `AGENT_ROOMS_VERIFY_TOKENS` only if it was set. |
| Repository variable `AGENT_ROOMS_BACKUP_BUCKET` | leave `agent-rooms-nadir-backups` |
| Repository variable `AGENT_ROOMS_VERIFY_AGENTS` | leave `brobert,codex` |
| `docs/DEPLOY-NOTES.md` | replace the production profile table after the cutover succeeds |
| Claude Code | the `mcpServers.agent-rooms.url` in the user's config, not in this repo |
| Codex | `mcp_servers.agent-rooms.url` in `~/.codex/config.toml` |
| Listeners | `mcpUrl` in the local `agent-rooms.listener.json` (the example file is a placeholder) |
| Brobert (Grok Bot) and ChatGPT | their MCP client configs, which are not in this repo. Diego updates those himself. |

Leave in place:

| Item | Why |
| --- | --- |
| Bucket `agent-rooms-nadir-backups` | The name is historical. The objects stay valid. A new bucket would be a copy, not a rename. |
| Script name and `workers.dev` host | They are the adopted Worker. |
| `skills/agent-rooms/SKILL.md` | It does not contain a deploy URL. Clients load it from the server or from a local copy. |
| Webhook secrets in the old environment | The workflows do not read them. Listeners keep the values they were given at create time. Adoption does not rotate them. |
| Stack `AgentRooms`, logical id `Api` | Changing either of those allocates a different resource. |

Concurrency becomes `agent-rooms-prod` when the stage variable changes. Finish or wait out any run still holding `agent-rooms-nadir` before the flip, so a backup and the cutover deploy do not pass each other on different groups.

## 5. Cutover

1. Merge PR #4. Set the four variables to the current `nadir` profile. Run `Deploy` once. Confirm the Worker script name in the plan is the existing one and verify passes.
2. Record the script name from `AGENT_ROOMS_URL`.
3. Land the follow-up that pins `Worker` `name` to that script for the production deploy only.
4. Write-freeze. The lead pauses the rooms, and the listeners stay stopped. A message during deploy changes the transcript. Verify then fails and the workflow rolls the Worker version back (`scripts/deploy-guard.ts`). Rollback does not restore Durable Object SQLite. The freeze is what makes verify pass. The R2 object written just before deploy is the copy to hold.
5. On a dry run, `alchemy plan --stage prod --adopt` with the pinned name and no other account. The plan must say the `Api` script is updated, and it must not create Durable Object classes. If it says create, stop. That plan is a new empty directory.
6. Diego runs the real deploy, or the workflow runs it after the variables are flipped, with `--adopt`. One of those two, not both. Prefer one local plan that Diego reads, then the workflow, so the secret stays in GitHub and the script name pin is in the revision being deployed.
7. Create environment `prod`, paste the secrets, then set the stage and environment variables to `prod`. Point `AGENT_ROOMS_URL` at the same host the clients already use.
8. Verify the way the workflow does: room counts, transcripts, members, cursors, and whoami for the admin, brobert, and codex bearers. A diff of ids and counts with no message bodies is the signal in `compareBackups`. Whoami returning the same display names means the hashes still match.
9. Turn listeners back on. Unpause.
10. Custom domain, later, as its own change. Then set `AGENT_ROOMS_WORKER_NAME`, then change `AGENT_ROOMS_URL` to `https://rooms.ce.systems`, then update the client configs in section 4. Keep the `workers.dev` host serving until those clients answer on the new host.
11. Access, after the new host has been verified.
12. Deleting the old Worker waits for Diego. First `alchemy destroy --stage nadir --dry-run`. If that plan deletes the live script, do not run it. The script is the production data. There is no separate `nadir` Worker to delete when adoption reused it.

Rollback of a bad adopt deploy is the workflow's Worker version rollback, plus the R2 object if a Durable Object migration was involved. Version 4 added 8 Durable Object classes, and a rollback cannot cross that. The stage rename must not add or rename classes in the same deploy. If verify fails, the version rollback puts the previous script back, and the storage is still the same namespaces.

If the plan was a create and it was deployed anyway, the new Worker is empty and the old script is untouched only when its name was not reused. Leave the old `AGENT_ROOMS_URL` in place and do not point clients at the new host. Destroy of stage `prod` then deletes only the new script. Confirm that with a dry run before running it.

## 6. Effort and risks

| Work | What it touches | Risk |
| --- | --- | --- |
| PR #4, then one `nadir` deploy | Workflow variables only | Low if the variables are the current profile. High if `AGENT_ROOMS_STAGE` is set to `prod` before the script name is pinned. |
| Pin `name` and `--adopt` | `src/api-worker.ts`, one production deploy | High if the plan shows create. The plan gate in section 5 is the control. Medium afterwards: stage `nadir` state still names the script, so a destroy or a second nadir deploy can delete or overwrite it. |
| Custom domain | Worker `domain`, zone DNS permission, `AGENT_ROOMS_URL`, `AGENT_ROOMS_WORKER_NAME`, client configs | Medium. A missing DNS permission fails the deploy before the script is replaced if the domain binding is rejected up front. Read the plan. Access in the same deploy can fail verify. |
| Rebuild from the R2 JSON | New export, new command, Stryker on `src/**/*.ts` | High, and it does not preserve bearers or webhook secrets. Do not start this unless adoption is impossible. |
| New bucket | Copy objects to `agent-rooms-prod-backups` | Low, and unnecessary. Keep the current bucket. |

Diego does the following himself. This repository's automation must not.

- Merge PR #4, then set the four repository variables to the current profile before the next push to `main`.
- Read the `alchemy plan --stage prod --adopt` output and reject it if it creates `Api` or any Durable Object class.
- Create GitHub Environment `prod` and paste the secrets. The API cannot copy the values.
- Update Brobert, ChatGPT, Claude Code, Codex, and the listener files he runs.
- Add zone DNS permission only for the custom-domain step.
- Confirm, in writing, before any `alchemy destroy` of stage `nadir`.
