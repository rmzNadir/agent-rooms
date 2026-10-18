import type { MemberKind } from "./actor.ts";
import type { AgentId } from "./ids.ts";

export const HOP_LIMIT = 20;

export const DEBOUNCE_MS = 3000;

export const COOLDOWN_MS = 5000;

export const MAX_WAIT_MS = 25_000;

export const MAX_WAKE_ATTEMPTS = 8;

export interface WakeMember {
  readonly agentId: AgentId;
  readonly displayName: string;
  readonly kind: MemberKind;
}

type WakeRejection =
  | { readonly _tag: "RejectUntagged" }
  | { readonly _tag: "UnknownMention"; readonly token: string }
  | { readonly _tag: "SelfMentionOnly" };

interface WakeAcceptance {
  readonly _tag: "Accept";
  readonly nextHopCount: number;
  readonly notifyHuman: boolean;
  readonly paused: boolean;
  readonly resetHops: boolean;
  readonly storedMentions: readonly string[];
  readonly targets: readonly AgentId[];
}

export type WakePlan = WakeRejection | WakeAcceptance;

const mentionPattern = /(?:^|[^A-Za-z0-9_])@[A-Za-z0-9_-]+/g;

export const tokensInBody = (body: string): readonly string[] => {
  const found: string[] = [];
  for (const match of body.matchAll(mentionPattern)) {
    const token = match[0].slice(match[0].lastIndexOf("@") + 1);
    if (!found.includes(token)) {
      found.push(token);
    }
  }
  return found;
};

const resolveToken = (
  token: string,
  members: readonly WakeMember[]
):
  | { readonly _tag: "All" }
  | { readonly _tag: "Human" }
  | { readonly _tag: "Agent"; readonly agentId: AgentId }
  | { readonly _tag: "Unknown" } => {
  const normalized = token.toLowerCase();
  if (normalized === "all") {
    return { _tag: "All" };
  }
  if (normalized === "human") {
    return { _tag: "Human" };
  }
  const byName = members.find((member) => member.displayName === token);
  if (byName !== undefined) {
    return { _tag: "Agent", agentId: byName.agentId };
  }
  const byId = members.find((member) => member.agentId === token);
  if (byId !== undefined) {
    return { _tag: "Agent", agentId: byId.agentId };
  }
  return { _tag: "Unknown" };
};

const uniqueTokensOf = (
  explicit: readonly string[],
  body: string
): readonly string[] => {
  const unique: string[] = [];
  for (const token of [...explicit, ...tokensInBody(body)]) {
    const trimmed = token.startsWith("@") ? token.slice(1) : token;
    if (trimmed.length > 0 && !unique.includes(trimmed)) {
      unique.push(trimmed);
    }
  }
  return unique;
};

interface MentionScan {
  readonly all: boolean;
  readonly human: boolean;
  readonly mentioned: readonly AgentId[];
}

const scanMentions = (
  tokens: readonly string[],
  members: readonly WakeMember[]
): MentionScan | WakeRejection => {
  let all = false;
  let human = false;
  const mentioned: AgentId[] = [];
  for (const token of tokens) {
    const resolved = resolveToken(token, members);
    if (resolved._tag === "Unknown") {
      return { _tag: "UnknownMention", token };
    }
    if (resolved._tag === "All") {
      all = true;
    } else if (resolved._tag === "Human") {
      human = true;
    } else if (resolved._tag === "Agent") {
      mentioned.push(resolved.agentId);
    }
  }
  return { all, human, mentioned };
};

const agentIdsOf = (members: readonly WakeMember[]): readonly AgentId[] =>
  members
    .filter((member) => member.kind === "agent")
    .map((member) => member.agentId);

const exceptAuthor = (ids: readonly AgentId[], authorId: AgentId) =>
  ids.filter((id) => id !== authorId);

const accept = (input: {
  readonly nextHopCount: number;
  readonly notifyHuman: boolean;
  readonly paused: boolean;
  readonly resetHops: boolean;
  readonly storedMentions: readonly string[];
  readonly targets: readonly AgentId[];
}): WakeAcceptance => ({ _tag: "Accept", ...input });

const humanPlan = (
  authorId: AgentId,
  tokens: readonly string[],
  scan: MentionScan,
  agents: readonly AgentId[]
): WakeAcceptance =>
  accept({
    nextHopCount: 0,
    notifyHuman: false,
    paused: false,
    resetHops: true,
    storedMentions: tokens.length === 0 ? ["all"] : tokens,
    targets: exceptAuthor(
      scan.all || tokens.length === 0
        ? agents
        : scan.mentioned.filter((id) => agents.includes(id)),
      authorId
    ),
  });

const pausedPlan = (
  hopCount: number,
  paused: boolean,
  tokens: readonly string[],
  requested: readonly AgentId[]
): WakeAcceptance =>
  accept({
    nextHopCount: hopCount,
    notifyHuman: !paused && requested.length > 0,
    paused: true,
    resetHops: false,
    storedMentions: tokens,
    targets: [],
  });

const agentPlan = (
  authorId: AgentId,
  hopCount: number,
  paused: boolean,
  tokens: readonly string[],
  scan: MentionScan,
  agents: readonly AgentId[]
): WakePlan => {
  if (
    !(scan.all || scan.human) &&
    exceptAuthor(scan.mentioned, authorId).length === 0
  ) {
    return { _tag: "SelfMentionOnly" };
  }
  const requested = exceptAuthor(
    scan.all ? agents : scan.mentioned.filter((id) => agents.includes(id)),
    authorId
  );
  if (paused || hopCount >= HOP_LIMIT) {
    return pausedPlan(hopCount, paused, tokens, requested);
  }
  return accept({
    nextHopCount: requested.length > 0 ? hopCount + 1 : hopCount,
    notifyHuman: false,
    paused: false,
    resetHops: false,
    storedMentions: tokens,
    targets: requested,
  });
};

export const planPost = (input: {
  readonly authorId: AgentId;
  readonly authorKind: MemberKind;
  readonly body: string;
  readonly explicitMentions: readonly string[];
  readonly members: readonly WakeMember[];
  readonly hopCount: number;
  readonly paused: boolean;
}): WakePlan => {
  const tokens = uniqueTokensOf(input.explicitMentions, input.body);
  if (input.authorKind === "agent" && tokens.length === 0) {
    return { _tag: "RejectUntagged" };
  }
  const scanned = scanMentions(tokens, input.members);
  if ("_tag" in scanned) {
    return scanned;
  }
  const agents = agentIdsOf(input.members);
  if (input.authorKind === "human") {
    return humanPlan(input.authorId, tokens, scanned, agents);
  }
  return agentPlan(
    input.authorId,
    input.hopCount,
    input.paused,
    tokens,
    scanned,
    agents
  );
};

export const deliveryNotBefore = (
  now: number,
  lastDeliveredAt: number | undefined
): number => {
  const debounced = now + DEBOUNCE_MS;
  if (lastDeliveredAt === undefined) {
    return debounced;
  }
  return Math.max(debounced, lastDeliveredAt + COOLDOWN_MS);
};

const retryBaseMs = 1000;
const retryCapMs = 30_000;

export const retryDelayMs = (attempts: number): number => {
  const exponent = Math.min(Math.max(attempts, 1), 5);
  return Math.min(retryCapMs, retryBaseMs * 2 ** exponent);
};

export const outboxClaimMs = 60_000;

export type WakeStatus = "delivered" | "busy" | "failed";

export const classifyWakeStatus = (status: number): WakeStatus => {
  if (status === 202) {
    return "busy";
  }
  if (status >= 200 && status < 300) {
    return "delivered";
  }
  return "failed";
};
