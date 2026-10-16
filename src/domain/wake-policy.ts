import type { AgentId } from "./ids.ts"
import type { MemberKind } from "./actor.ts"

/** Agent-to-agent wakes allowed before the room pauses and notifies the human. */
export const HOP_LIMIT = 20

/** Mentions for one agent collapse into a single wake after this quiet period. */
export const DEBOUNCE_MS = 3_000

/** Minimum gap between webhook deliveries to the same agent. */
export const COOLDOWN_MS = 5_000

/** `wait_for_messages` never holds a request longer than this. */
export const MAX_WAIT_MS = 25_000

/** Webhook attempts before the room stops retrying that delivery. */
export const MAX_WAKE_ATTEMPTS = 8

/** A member the wake planner can address. */
export type WakeMember = {
  readonly agentId: AgentId
  readonly displayName: string
  readonly kind: MemberKind
}

/** Why a post was refused before it was stored. */
export type WakeRejection =
  | { readonly _tag: "RejectUntagged" }
  | { readonly _tag: "UnknownMention"; readonly token: string }
  | { readonly _tag: "SelfMentionOnly" }

/** What to store and who to wake after a post is accepted. */
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

const mentionPattern = /@([A-Za-z0-9_-]+)/g

/**
 * Pull `@tokens` out of a message body. The `@` is not part of the token.
 */
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
  const byName = members.find((member) => member.displayName.toLowerCase() === normalized)
  if (byName !== undefined) return { _tag: "Agent", agentId: byName.agentId }
  const byId = members.find((member) => member.agentId === token)
  if (byId !== undefined) return { _tag: "Agent", agentId: byId.agentId }
  return { _tag: "Unknown" }
}

/**
 * Decide whether a post is stored and which agents it wakes.
 *
 * Agents must name a real target. Untagged human posts wake every agent
 * (`@all`). The author is never a target. After {@link HOP_LIMIT} agent-to-agent
 * wakes with no human post, further agent wakes pause until a human writes.
 */
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

/**
 * When a webhook for this agent may be sent. Each new mention resets the
 * debounce, and a delivery cannot start inside the cooldown.
 */
export const deliveryNotBefore = (now: number, lastDeliveredAt: number | undefined): number => {
  const debounced = now + DEBOUNCE_MS
  if (lastDeliveredAt === undefined) return debounced
  return Math.max(debounced, lastDeliveredAt + COOLDOWN_MS)
}

/** Delay before the next webhook attempt. Attempt 1 waits 2s, then doubles, capped at 30s. */
export const retryDelayMs = (attempts: number): number => {
  const exponent = Math.min(Math.max(attempts, 1), 5)
  return Math.min(30_000, 1_000 * 2 ** exponent)
}
