# Stage rename plan

Planning only. This document does not deploy, does not change Cloudflare, and does not change GitHub variables, environments, or secrets.

[PR #4](https://github.com/rmzNadir/agent-rooms/pull/4) is on `main`. The repository variables are already `AGENT_ROOMS_STAGE=nadir`, `AGENT_ROOMS_GITHUB_ENVIRONMENT=nadir`, `AGENT_ROOMS_BACKUP_BUCKET=agent-rooms-nadir-backups`, and `AGENT_ROOMS_VERIFY_AGENTS=brobert,codex`. A `Deploy` run for that revision is in progress. Leave those four values alone until that run finishes. Do not set a domain variable on that run. The code on `main` does not read one.

## Order

Parameterize first, prove one ordinary `nadir` deploy, then rename the stage. That first part is done. The running deploy is the proof. Changing `AGENT_ROOMS_STAGE` while it is in progress would start a second Worker.

The stage cutover is an operator step plus one small code change that pins the existing script name. The custom domain is a later code change, described in section 3, and a later deploy. Access is a third step, after the hostname has been verified.

## Proposed names

| Thing | Proposed value | Why |
| --- | --- | --- |
| Alchemy stage | `prod` | Matches `^[a-z][a-z0-9-]{0,40}$` in `scripts/deploy-profile.ts`. It is not a person's handle. Alchemy's own default stage is `live_$USER` (`node_modules/alchemy/src/Cli/commands/flags.ts`), so `live` is a poor production name. |
| GitHub Environment | `prod` | The workflow selects `environment:` from `AGENT_ROOMS_GITHUB_ENVIRONMENT`. The pair should match. |
| Worker script | the script that exists today | Cloudflare does not rename a Worker. The public `workers.dev` host is that script name. Adopting it keeps every current client URL working through the stage change. The host still contains `nadir`. |
| Hostname, later | `rooms.ce.systems` | Optional repository variable `AGENT_ROOMS_DOMAIN`. Alchemy attaches that hostname to the adopted Worker. A later script move does not change the URL clients store. |
| R2 bucket | keep `agent-rooms-nadir-backups` | R2 buckets cannot be renamed. The objects are the restore copy. |

`prod` is one production stage. A second stage would be a second Worker and empty Durable Object storage.

## 1. What a new stage creates, and how to keep the data

`alchemy.run.ts` builds stack `AgentRooms`. State is the remote `alchemy-state-store` Worker unless `AGENT_ROOMS_LOCAL_STATE=1`. That store is one per account. Stages are rows inside it, keyed by stack name plus stage. A new stage does not create a second state store.

`src/api-worker.ts` declares logical id `Api` and does not set `WorkerProps.name`. `createWorkerName` in `node_modules/alchemy/src/Cloudflare/Workers/WorkerName.ts` then calls `createPhysicalName` and lowercases the result. The prefix is `${stack}-${id}-${stage}-` plus a 16-character base32 suffix of a new instance id (`node_modules/alchemy/src/PhysicalName.ts`). For stage `prod` the script name is `agentrooms-api-prod-` plus that suffix. It is not knowable before the first deploy. The script is tagged `alchemy:stack:AgentRooms`, `alchemy:stage:prod`, and `alchemy:id:Api`.

`workersDev` defaults to true, so the public URL is `https://<script>.<account-subdomain>.workers.dev`. Alchemy's `worker.url` is that host until a custom domain is attached. Durable Object classes on that script get new SQLite namespaces. Binding names are the class names. The classes hosted today are the legacy doors `DirectoryServer` and `RoomServer` (`src/runtime/legacy-door.ts`) and the domain classes `roomsOnCloudflare` declares through `node_modules/alchemy/src/Domain/Cloudflare.ts`. That file names each class `${aggregateName}Aggregate`, `${viewName}View`, `${policyName}Policy`, `${projectionName}Projection`, and `${streamName}Stream`. With the model in `src/model`, those classes are `DirectoryAggregate`, `RoomAggregate`, `TranscriptView`, `UnreadView`, `SearchIndexView`, `WakeDeliveryPolicy`, `TranscriptLinesProjection`, and `TranscriptLogStream`. A new script means new namespace ids and empty storage.

### Adoption keeps the storage. Recreate does not.

Two Alchemy mechanisms were checked in `2.0.0-beta.83`.

**Pin the script name and adopt it.** `createWorkerName` uses an explicit `name` when one is set. `Worker.read` treats a script as owned only when its tags contain this stack, this stage, and this logical id (`hasAlchemyWorkerTags` in `WorkerProvider.ts`). The live script is tagged `alchemy:stage:nadir`. A deploy of stage `prod` that sets `name` to that same script does not see its own tags, so the read is `Unowned`. `alchemy deploy --adopt --stage prod` then takes the script over and rewrites the tags to `alchemy:stage:prod`. The adopting-deploy note in `DurableObject.ts` says existing classes are reused in place when `className` matches. Storage stays. This is the path to use.

The repo does not set `name` today. The cutover needs a follow-up that sets the Worker `name` from an environment value for that one production deploy and leaves local `alchemy dev` unnamed. The value is the first label of the current `AGENT_ROOMS_URL` when that host is `workers.dev` (`scriptNameFromUrl` in `scripts/snapshot-diff.ts`).

**`transferredFrom` moves a class onto a new script.** `DurableObject.ts` can move a class and keep its data when the new host declares `transferredFrom` with the old physical script name. The domain classes are constructed by `alchemy/Domain/Cloudflare`'s `DurableObjects` layer. That layer does not expose `transferredFrom` (it is absent under `node_modules/alchemy/src/Domain`). Declaring it only on `DirectoryServer` and `RoomServer` would move the legacy doors and leave the model classes empty. A new script also means a new URL. The stage rename uses adoption.

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

## 3. Optional custom domain

Adopting the Worker keeps `nadir` in the `workers.dev` host. A custom domain is how clients get a stable URL. The same mechanism is how any other account puts agent-rooms on a hostname they already have. This revision pins the script name from `AGENT_ROOMS_URL` on a live deploy, passes `domain` when `AGENT_ROOMS_DOMAIN` is set, and adds the read-only workflow `Plan prod adopt`. The variable stays unset until the adopt plan has been accepted. `alchemy dev` and `AGENT_ROOMS_LOCAL_STATE` leave the script name unset. Durable Object class names stay the logical names, so they do not change with the stage.

### The Alchemy API

Alchemy `2.0.0-beta.83` attaches a hostname on the Worker resource. `WorkerProps.domain` in `node_modules/alchemy/src/Cloudflare/Workers/Worker.ts` is `string | WorkerDomainConfig | null`. A bare string is shorthand for `{ name }`. The installed provider creates the DNS record and the edge certificate itself, with `PUT /accounts/.../workers/domains` (`attachDomain` in `WorkerProvider.ts`). The zone must already exist. Alchemy does not register a domain and this design does not declare a `Zone` resource.

That is the same prop the [custom domains guide](https://alchemy.run/cloudflare/networking/custom-domains) tells a Worker to set (`domain: "api.example.com"`). The guide's site text is newer than `2.0.0-beta.83` (it imports `@alchemy.run/cloudflare` and shows a separate `WorkerRoute` resource). The prop we will set is the one in the installed `Worker.ts`. The guide's route-plus-`DNS.Record` example is a different feature: a route matches a path and the operator still creates the proxied record. One hostname for the whole Worker uses `domain`, which provisions DNS and the certificate.

`Cloudflare.CustomHostname` (`node_modules/alchemy/src/Cloudflare/CustomHostname/CustomHostname.ts`) is Cloudflare for SaaS. It onboards a customer-owned hostname onto a zone the operator already serves, with an ownership check. It is the wrong resource for `rooms.ce.systems`. There is no Worker `CustomDomain` resource in this version. The legacy `domains: string[]` shape is accepted only when reading old state (`resolveWorkerDomain`). New code passes `domain`.

`workersDev` stays at its default, `true`. The guide shows `workersDev: false` once a custom domain is the only URL. Leaving the default on keeps the adopted `workers.dev` host serving the same Worker, so clients that still have the old URL keep working. `computeWorkerUrls` ranks `https://<domain.name>` first, then aliases, then the stable `workers.dev` URL. `worker.url` becomes the custom host. The `workers.dev` URL stays in `worker.urls`. Redirects never appear in `urls`. This design sets no aliases and no redirects.

When the variable is a non-empty hostname the Worker is declared with `domain` set to that string. Zone lookup is Alchemy's default: `resolveZoneId` in `node_modules/alchemy/src/Cloudflare/Zone/lookup.ts` tries each parent label, longest first (`zoneNameCandidates`), with `GET /zones?name=` and an exact name plus account id (`findZoneByName`). For `rooms.ce.systems` the candidates are `rooms.ce.systems`, then `ce.systems`. The first zone on this account wins, which is `ce.systems` when that zone is the one on the account. A shorter accidental zone is why the lookup is exact. No second variable is required. `WorkerDomainConfig.zoneName` remains available if a later case has to pin a zone. The easy path is the one hostname.

### Unset means today's deploy

An absent or empty `AGENT_ROOMS_DOMAIN` omits the `domain` prop. The Worker is served on `workers.dev` exactly as `main` does today. No zone lookup runs, and the token does not need zone permissions.

Omitting the prop is also what Alchemy does when a domain was attached earlier and the variable disappears. The provider comment on that path (issue #942 in `WorkerProvider.ts`) says an omitted `domain` leaves live attachments in place. Passing `null` detaches every custom domain. This design does not pass `null` for an empty variable, so a workflow that forgets the variable cannot drop `rooms.ce.systems`. Removing the hostname is a later explicit `domain: null`, reviewed on its own.

A hostname already attached to a different Worker fails closed. `attachDomain` dies with `Cannot attach hostname '<host>' to Worker '<script>': it is already attached to Worker '<other>'`. The same Worker is a no-op.

### Repository variable

`AGENT_ROOMS_DOMAIN` is an optional repository variable, not a secret. The hostname is public. Setup stores it with `gh variable set`, the same way it stores the stage and the bucket. An empty value does not write the variable and does not delete one that is already set. An operator who wants the variable gone deletes it themselves. The next deploy then omits `domain` and, per the rule above, leaves an existing attachment serving.

The profile preflight job can check the shape, because that job has no Cloudflare token. The zone check needs the token, so it runs in `scripts/setup-account.ts` and again inside Alchemy during deploy.

Accepted value: a bare hostname. Reject a scheme, a path, a port, a space, and any host that is or ends with `.workers.dev`. `scriptNameFromUrl` treats `.workers.dev` as a script name. Putting that host in `domain` would ask Cloudflare to attach the wrong kind of name.

### Setup and the README

`scripts/setup-account.ts` and the README section "Deploy to your own Cloudflare account" grow one optional input.

```sh
export AGENT_ROOMS_DOMAIN="rooms.example.com"   # optional
bun scripts/setup-account.ts
```

When the variable is unset, setup is the script that exists today. The five ongoing token groups stay `Workers Scripts Read`, `Workers Scripts Write`, `Workers R2 Storage Read`, `Workers R2 Storage Write`, and `Secrets Store Read`. Bootstrap still needs `Secrets Store Write` once.

When the variable is set, two more groups are required on every deploy that passes `domain`, scoped to that zone. They are not a one-time bootstrap permission.

| Group | Catalog name in `PermissionGroups.ts` | Why |
| --- | --- | --- |
| Zone read | `Zone Read` (zone scope) | `GET /zones?name=` |
| DNS edit | `DNS Write` (zone scope). The dashboard labels this DNS Edit | `PUT /accounts/.../workers/domains` creates the record and the certificate |

`Zone DNS Settings Read` and `Zone DNS Settings Write` are a different pair. `Workers Routes Write` belongs to the route API, which this design does not call.

Setup order when a domain is present, before bootstrap and before any `gh` write:

1. Reject a bad hostname with `AGENT_ROOMS_DOMAIN must be a bare hostname` or `AGENT_ROOMS_DOMAIN must not be a workers.dev host`.
2. Walk parent labels the way `zoneNameCandidates` does. Require an exact zone name on this account id.
3. On no match, fail with Alchemy's sentence `Cloudflare zone not found for <hostname>` and a second sentence: the zone must already be on this account, and the token needs `Zone Read` and `DNS Write` on that zone. Setup does not create the zone.
4. On HTTP 403 from that lookup, fail with `Zone Read is missing for <hostname>`. The message does not include the token.

The README tells a new account the same facts. Create the zone in Cloudflare first, and point the registrar at its nameservers, before setting the variable. Then export `AGENT_ROOMS_DOMAIN` and run setup. The extra two groups are listed next to the five, marked as required only when that variable is set. The README keeps a workers.dev walkthrough as the default and adds the domain as an optional paragraph, so a reader who skips it gets today's deploy.

### How verify, conformance, e2e, and clients pick the URL

One public base:

- `AGENT_ROOMS_DOMAIN` set: `https://` plus that hostname
- otherwise: `AGENT_ROOMS_URL`

That base is what backup reads, what `deploy-guard` verify calls, and what `scripts/conformance.ts`, `scripts/live-e2e.ts`, and the nightly backup use. Client docs (Claude Code, Codex, and any other MCP client) use `https://<public host>/mcp`. Listeners keep using `mcpUrl` in the local `agent-rooms.listener.json`. The skill file stays free of a deploy URL.

Pin and rollback stay on `workerScript` in `scripts/deploy-guard.ts`. That function takes the first label of a `workers.dev` host and uses `AGENT_ROOMS_WORKER_NAME` only when the URL is some other host. Keep `AGENT_ROOMS_URL` as the `workers.dev` URL. The domain variable is the public URL. Pin then keeps working with no worker-name secret.

Alchemy prints `worker.url` as the custom host once `domain` is set. The `workers.dev` URL is the later entry in `worker.urls`. The README says to store that `workers.dev` entry as `AGENT_ROOMS_URL`. Storing `worker.url` in `AGENT_ROOMS_URL` makes the next pin throw `missing AGENT_ROOMS_WORKER_NAME for a non workers.dev AGENT_ROOMS_URL` unless the worker-name secret is set too.

Today `.github/workflows/deploy.yml` gates backup, pin, verify, conformance, live e2e, and the sweep on `env.AGENT_ROOMS_URL != ''`. The follow-up splits that gate.

| Step | When it runs |
| --- | --- |
| Pre-deploy backup and pin | `AGENT_ROOMS_URL` is set, as today. A first deploy of a new script has nothing to pin and no previous transcript to copy. |
| Post-deploy verify, conformance, live e2e, sweep | The public base is known. A domain-only first deploy runs these against `https://<domain>` after Alchemy has attached the hostname. |
| Rollback | Still requires the pin step to have succeeded, and still uses the script name from the `workers.dev` URL or from `AGENT_ROOMS_WORKER_NAME`. |
| Nightly backup | Uses the public base. A domain with no `AGENT_ROOMS_URL` still backs up. Both empty still fails closed. |

The pre-deploy backup keeps reading `AGENT_ROOMS_URL` when that secret is the `workers.dev` host, because that host is the service that already has the data. After the domain is attached, both hosts are the same Worker. Verify after that deploy uses the public base, so a bad certificate or a bad DNS record fails the job the clients will actually call.

### Where `rooms.ce.systems` sits for this account

1. The `nadir` deploy that is running now finishes on the current Worker. The four variables stay as they are.
2. The stage adopt in section 5 runs later, still on the `workers.dev` host. Clients do not move.
3. The domain follow-up lands. Diego adds `Zone Read` and `DNS Write` on the zone `ce.systems` to the deploy token, then sets the repository variable `AGENT_ROOMS_DOMAIN=rooms.ce.systems`. That deploy attaches DNS and the certificate. `AGENT_ROOMS_URL` stays the `workers.dev` secret so pin still derives the script name. `workersDev` stays on.
4. Verify, conformance, and the live suite run against `https://rooms.ce.systems`. Diego then updates Claude Code, Codex, listeners, Brobert, and ChatGPT.
5. Access is the step after that. It is not part of the domain deploy.

Access stays a separate change so a wrong policy cannot lock verify out of the new host. The README already states the two workable policies. Access is the network gate. The bearer is still the application identity.

- Protect the whole hostname and give every MCP client `CF-Access-Client-Id` and `CF-Access-Client-Secret`, or
- Bypass Access for `POST /mcp` and `/admin/*`, and require Access for `/` and `/rooms/*`.

The bypass policy lets the existing clients keep their bearer-only configs. `WorkerProps.access` in `Worker.ts` can enroll the custom domain and the `workers.dev` host in one Access application. That enrollment is the Access step, not the domain step. The viewer cookie `agent_rooms_token` is already `Secure` on `https://` requests.

## 4. What has to change, and what stays

Nothing in git contains the live URL. `docs/DEPLOY-NOTES.md` says the URL is the secret `AGENT_ROOMS_URL`.

Change at the stage cutover, after the adopt plan is an update. The domain variable is not part of this cutover.

| Item | Change |
| --- | --- |
| Repository variable `AGENT_ROOMS_STAGE` | `prod` |
| Repository variable `AGENT_ROOMS_GITHUB_ENVIRONMENT` | `prod` |
| GitHub Environment | Create `prod`. GitHub does not rename an environment. Secret values cannot be read back, so Diego pastes each value into the new environment. |
| Secrets to paste | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `AGENT_ROOMS_ADMIN_TOKEN`, `AGENT_ROOMS_URL` (the current `workers.dev` host), `AGENT_ROOMS_BROBERT_TOKEN`, `AGENT_ROOMS_CODEX_TOKEN`. `AGENT_ROOMS_VERIFY_TOKENS` only if it was set. |
| Repository variable `AGENT_ROOMS_BACKUP_BUCKET` | leave `agent-rooms-nadir-backups` |
| Repository variable `AGENT_ROOMS_VERIFY_AGENTS` | leave `brobert,codex` |
| `docs/DEPLOY-NOTES.md` | replace the production profile table after the cutover succeeds |
| Claude Code | the `mcpServers.agent-rooms.url` in the user's config, not in this repo. Stays on the `workers.dev` host until section 3 step 4. |
| Codex | `mcp_servers.agent-rooms.url` in `~/.codex/config.toml` |
| Listeners | `mcpUrl` in the local `agent-rooms.listener.json` (the example file is a placeholder) |
| Brobert (Grok Bot) and ChatGPT | their MCP client configs, which are not in this repo. Diego updates those himself. |

Leave in place through the stage cutover:

| Item | Why |
| --- | --- |
| Bucket `agent-rooms-nadir-backups` | The name is historical. The objects stay valid. A new bucket would be a copy, not a rename. |
| Script name and `workers.dev` host | They are the adopted Worker. |
| `AGENT_ROOMS_URL` | Stays the `workers.dev` URL so pin keeps reading the script name after the domain is attached. |
| `skills/agent-rooms/SKILL.md` | It does not contain a deploy URL. Clients load it from the server or from a local copy. |
| Webhook secrets in the old environment | The workflows do not read them. Listeners keep the values they were given at create time. Adoption does not rotate them. |
| Stack `AgentRooms`, logical id `Api` | Changing either of those allocates a different resource. |
| `AGENT_ROOMS_DOMAIN` | Unset until the domain follow-up has landed and the adopt deploy has been verified. |

Concurrency becomes `agent-rooms-prod` when the stage variable changes. Finish or wait out any run still holding `agent-rooms-nadir` before the flip, so a backup and the cutover deploy do not pass each other on different groups.

## 5. Cutover

1. The merged revision is deploying now with the four variables set to the `nadir` profile. Wait until that run's verify passes. Record the script name from `AGENT_ROOMS_URL`. Do not change the stage and do not set `AGENT_ROOMS_DOMAIN` during that run.
2. Land the follow-up that pins `Worker` `name` to that script for the production deploy only.
3. Write-freeze. The lead pauses the rooms, and the listeners stay stopped. A message during deploy changes the transcript. Verify then fails and the workflow rolls the Worker version back (`scripts/deploy-guard.ts`). Rollback does not restore Durable Object SQLite. The freeze is what makes verify pass. The R2 object written just before deploy is the copy to hold.
4. On a dry run, `alchemy plan --stage prod --adopt` with the pinned name and no other account. The plan must say the `Api` script is updated, and it must not create Durable Object classes. If it says create, stop. That plan is a new empty directory.
5. Diego runs the real deploy, or the workflow runs it after the variables are flipped, with `--adopt`. One of those two, not both. Prefer one local plan that Diego reads, then the workflow, so the secret stays in GitHub and the script name pin is in the revision being deployed.
6. Create environment `prod`, paste the secrets, then set the stage and environment variables to `prod`. Point `AGENT_ROOMS_URL` at the same `workers.dev` host the clients already use.
7. Verify the way the workflow does: room counts, transcripts, members, cursors, and whoami for the admin, brobert, and codex bearers. A diff of ids and counts with no message bodies is the signal in `compareBackups`. Whoami returning the same display names means the hashes still match.
8. Turn listeners back on. Unpause.
9. Land the domain follow-up from section 3. Add `Zone Read` and `DNS Write` on `ce.systems`. Set `AGENT_ROOMS_DOMAIN` to `rooms.ce.systems`. Leave `AGENT_ROOMS_URL` as the `workers.dev` host. Verify against `https://rooms.ce.systems`, then update the client configs in section 4. Keep the `workers.dev` host serving.
10. Access, after the new host has been verified.
11. Deleting the old Worker waits for Diego. First `alchemy destroy --stage nadir --dry-run`. If that plan deletes the live script, do not run it. The script is the production data. There is no separate `nadir` Worker to delete when adoption reused it.

Rollback of a bad adopt deploy is the workflow's Worker version rollback, plus the R2 object if a Durable Object migration was involved. Version 4 added 8 Durable Object classes, and a rollback cannot cross that. The stage rename must not add or rename classes in the same deploy. If verify fails, the version rollback puts the previous script back, and the storage is still the same namespaces.

If the plan was a create and it was deployed anyway, the new Worker is empty and the old script is untouched only when its name was not reused. Leave the old `AGENT_ROOMS_URL` in place and do not point clients at the new host. Destroy of stage `prod` then deletes only the new script. Confirm that with a dry run before running it.

## 6. Effort and risks

| Work | What it touches | Risk |
| --- | --- | --- |
| The `nadir` deploy that is running | Variables already set on `main` | Low while the stage stays `nadir`. High if `AGENT_ROOMS_STAGE` is flipped to `prod` before the script name is pinned. |
| Pin `name` and `--adopt` | `src/api-worker.ts`, one production deploy | High if the plan shows create. The plan gate in section 5 is the control. Medium afterwards: stage `nadir` state still names the script, so a destroy or a second nadir deploy can delete or overwrite it. |
| `AGENT_ROOMS_DOMAIN` | Worker `domain`, setup, the README, the public-URL gate in the workflows, zone token groups | Medium. A missing zone fails before GitHub writes when setup is used, and fails in Alchemy with `Cloudflare zone not found for <hostname>` when the variable is set by hand. A hostname owned by another Worker fails before traffic moves. Leaving `workersDev` on means the old host still serves if DNS is late. Access in the same deploy can fail verify. |
| Rebuild from the R2 JSON | New export, new command, Stryker on `src/**/*.ts` | High, and it does not preserve bearers or webhook secrets. Do not start this unless adoption is impossible. |
| New bucket | Copy objects to `agent-rooms-prod-backups` | Low, and unnecessary. Keep the current bucket. |

Diego does the following himself. This repository's automation must not.

- Let the current `Deploy` run finish before changing any repository variable.
- Read the `alchemy plan --stage prod --adopt` output and reject it if it creates `Api` or any Durable Object class.
- Create GitHub Environment `prod` and paste the secrets. The API cannot copy the values.
- Update Brobert, ChatGPT, Claude Code, Codex, and the listener files he runs. The stage adopt does not require that. The `rooms.ce.systems` cutover does.
- Add `Zone Read` and `DNS Write` on `ce.systems` only when he is ready to set `AGENT_ROOMS_DOMAIN`.
- Confirm, in writing, before any `alchemy destroy` of stage `nadir`.
