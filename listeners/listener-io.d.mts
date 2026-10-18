export interface WakeCall {
  readonly agentId?: string;
  readonly deliveryId?: string;
  readonly fromSeq?: number;
  readonly hopCount?: number;
  readonly paused?: boolean;
  readonly roomId?: string;
  readonly roomName?: string;
  readonly sinceCursor?: number;
  readonly toSeq?: number;
  readonly triggeringMessageIds?: readonly string[];
  readonly youAreLead?: boolean;
}

export interface ListenerConfig {
  readonly agentName?: string;
  readonly bearerToken?: string;
  readonly claudeBin?: string;
  readonly claudeExtraArgs?: readonly string[];
  readonly codexBin?: string;
  readonly codexExtraArgs?: string[];
  readonly host?: string;
  readonly mcpUrl?: string;
  readonly port?: number;
  readonly webhookSecret?: string;
  readonly workdir?: string;
}

export interface Lane {
  admit: (key: string, wake: WakeCall) => "start" | "coalesced";
  finish: (key: string) => WakeCall | undefined;
  release: (key: string) => void;
}

export interface HarnessBody {
  readonly code?: number | null;
  readonly message?: string;
  readonly ok: boolean;
  readonly stderr?: string;
  readonly stdout?: string;
}

export interface HarnessResult {
  readonly body: HarnessBody;
  readonly status: number;
}

export type PendingPhase =
  | "exhausted"
  | "queued"
  | "reported"
  | "retry"
  | "running"
  | "succeeded";

export interface PendingRecord {
  readonly attempts: number;
  readonly followUp: WakeCall | null;
  readonly phase: PendingPhase;
  readonly wake: WakeCall;
}

export function verifySignature(
  secret: string,
  timestamp: string,
  body: string,
  header: string
): boolean;
export function rememberSignature(
  seen: Map<string, number>,
  signature: string,
  now: number
): boolean;
export function signatureDigest(header: string): string;
export function acceptDelivery(
  seen: Map<string, number>,
  deliveryId: string,
  now: number,
  ttl?: number
): "duplicate" | "fresh" | "missing";
export function createLane(): Lane;
export const maxHarnessAttempts: number;
export function harnessRetryDelayMs(attemptsSoFar: number): number;
export function readPendingFile(
  dir: string,
  roomId: string,
  agentId: string
): PendingRecord | undefined;
export function writePendingFile(
  dir: string,
  roomId: string,
  agentId: string,
  record: PendingRecord
): void;
export function removePendingFile(
  dir: string,
  roomId: string,
  agentId: string
): void;
export function acceptPending(
  dir: string,
  wake: { agentId: string; deliveryId: string; roomId: string }
): "queued" | "same" | "start";
export function postFailure(
  config: { bearerToken?: string; mcpUrl?: string },
  wake: { fromSeq: number; roomId: string; toSeq: number },
  fetchImpl?: (
    url: string,
    init: { body: string; headers: Record<string, string>; method: string }
  ) => Promise<{ ok: boolean; text: () => Promise<string> }>
): Promise<boolean>;
export function writeSessionFile(
  dir: string,
  roomId: string,
  agentId: string,
  sessionId: string
): void;
export function readSessionFile(
  dir: string,
  roomId: string,
  agentId: string
): string | undefined;
export function replaceFile(
  tmp: string,
  dest: string,
  fsImpl?: {
    renameSync: (from: string, to: string) => void;
    rmSync: (path: string, options?: { force?: boolean }) => void;
  }
): void;
export function recordDelivery(
  dir: string,
  roomId: string,
  agentId: string,
  deliveryId: string,
  now: number
): "duplicate" | "fresh" | "missing";
export function findSessionId(stdout: string): string | undefined;
export function codexArgs(
  extraArgs: readonly string[],
  previous: string | undefined,
  prompt: string
): string[];
export function spawnHarness(input: {
  args: readonly string[];
  bin: string;
  cwd: string;
  env: Record<string, string | undefined>;
}): Promise<HarnessResult>;
export function loadConfig(): ListenerConfig;
export function writeMcpConfig(config: ListenerConfig): string;
export function sessionFor(
  roomId: string | undefined,
  agentId: string | undefined
): string | undefined;
export function stateDir(): string;
