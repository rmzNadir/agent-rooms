import type { AgentId } from "./ids.ts"
import type { MemberKind } from "./actor.ts"

export const HOP_LIMIT = 20

export const DEBOUNCE_MS = 3_000

export const COOLDOWN_MS = 5_000

export const MAX_WAIT_MS = 25_000

export const MAX_WAKE_ATTEMPTS = 8

export type WakeMember = {
  readonly agentId: AgentId
  readonly displayName: string
  readonly kind: MemberKind
}

export type WakeRejection =
  | { readonly _tag: "RejectUntagged" }
  | { readonly _tag: "UnknownMention"; readonly token: string }
  | { readonly _tag: "SelfMentionOnly" }

export type WakeAcceptance = {
  readonly _tag: "Accept"
  readonly targets: ReadonlyArray<AgentId>
  readonly storedMentions: ReadonlyArray<string>
  readonly nextHopCount: number
  readonly paused: boolean
  readonly resetHops: boolean
  readonly notifyHuman: boolean
}

export type WakePlan = WakeRejection | WakeAcceptance

const mentionPattern = /(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_-]+)/g

export const tokensInBody = (body: string): ReadonlyArray<string> => {
  const found: string[] = []
  for (const match of body.matchAll(mentionPattern)) {
    const token = match[1]
    if (token !== undefined && !found.includes(token)) found.push(token)
  }
  return found
}

const resolveToken = (
  token: string,
  members: ReadonlyArray<WakeMember>,
): { readonly _tag: "All" } | { readonly _tag: "Human" } | { readonly _tag: "Agent"; readonly agentId: AgentId } | { readonly _tag: "Unknown" } => {
  const normalized = token.toLowerCase()
  if (normalized === "all") return { _tag: "All" }
  if (normalized === "human") return { _tag: "Human" }
  const byName = members.find((member) => member.displayName === token)
  if (byName !== undefined) return { _tag: "Agent", agentId: byName.agentId }
  const byId = members.find((member) => member.agentId === token)
  if (byId !== undefined) return { _tag: "Agent", agentId: byId.agentId }
  return { _tag: "Unknown" }
}

export const planPost = (input: {
  readonly authorId: AgentId
  readonly authorKind: MemberKind
  readonly body: string
  readonly explicitMentions: ReadonlyArray<string>
  readonly members: ReadonlyArray<WakeMember>
  readonly hopCount: number
  readonly paused: boolean
}): WakePlan => {
  const tokens = [...input.explicitMentions, ...tokensInBody(input.body)]
  const uniqueTokens: string[] = []
  for (const token of tokens) {
    const trimmed = token.startsWith("@") ? token.slice(1) : token
    if (trimmed.length > 0 && !uniqueTokens.includes(trimmed)) uniqueTokens.push(trimmed)
  }

  if (input.authorKind === "agent" && uniqueTokens.length === 0) {
    return { _tag: "RejectUntagged" }
  }

  let all = false
  let human = false
  const mentioned: AgentId[] = []
  for (const token of uniqueTokens) {
    const resolved = resolveToken(token, input.members)
    if (resolved._tag === "Unknown") return { _tag: "UnknownMention", token }
    if (resolved._tag === "All") all = true
    else if (resolved._tag === "Human") human = true
    else if (!mentioned.includes(resolved.agentId)) mentioned.push(resolved.agentId)
  }

  const agents = input.members.filter((member) => member.kind === "agent").map((member) => member.agentId)
  const withoutSelf = (ids: ReadonlyArray<AgentId>) => ids.filter((id) => id !== input.authorId)

  if (input.authorKind === "human") {
    const targets = withoutSelf(all || uniqueTokens.length === 0 ? agents : mentioned.filter((id) => agents.includes(id)))
    const stored = uniqueTokens.length === 0 ? ["all"] : uniqueTokens
    return {
      _tag: "Accept",
      targets,
      storedMentions: stored,
      nextHopCount: 0,
      paused: false,
      resetHops: true,
      notifyHuman: false,
    }
  }

  if (!all && !human && mentioned.length > 0 && withoutSelf(mentioned).length === 0) {
    return { _tag: "SelfMentionOnly" }
  }

  const requested = withoutSelf(all ? agents : mentioned.filter((id) => agents.includes(id)))
  if (input.paused || input.hopCount >= HOP_LIMIT) {
    return {
      _tag: "Accept",
      targets: [],
      storedMentions: uniqueTokens,
      nextHopCount: input.hopCount,
      paused: true,
      resetHops: false,
      notifyHuman: !input.paused && input.hopCount >= HOP_LIMIT && requested.length > 0,
    }
  }

  return {
    _tag: "Accept",
    targets: requested,
    storedMentions: uniqueTokens,
    nextHopCount: requested.length > 0 ? input.hopCount + 1 : input.hopCount,
    paused: false,
    resetHops: false,
    notifyHuman: false,
  }
}

export const deliveryNotBefore = (now: number, lastDeliveredAt: number | undefined): number => {
  const debounced = now + DEBOUNCE_MS
  if (lastDeliveredAt === undefined) return debounced
  return Math.max(debounced, lastDeliveredAt + COOLDOWN_MS)
}

const retryBaseMs = 1_000
const retryCapMs = 30_000

export const retryDelayMs = (attempts: number): number => {
  const exponent = Math.min(Math.max(attempts, 1), 5)
  return Math.min(retryCapMs, retryBaseMs * 2 ** exponent)
}

export const outboxClaimMs = 60_000

export type WakeStatus = "delivered" | "busy" | "failed"

export const classifyWakeStatus = (status: number): WakeStatus => {
  if (status === 202) return "busy"
  if (status >= 200 && status < 300) return "delivered"
  return "failed"
}
