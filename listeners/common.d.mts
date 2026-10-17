export function verifySignature(secret: string, timestamp: string, body: string, header: string): boolean
export function rememberSignature(seen: Map<string, number>, signature: string, now: number): boolean
export function signatureDigest(header: string): string
export function acceptDelivery(seen: Map<string, number>, deliveryId: string, now: number, ttl?: number): "missing" | "duplicate" | "fresh"
export function createLane(): {
  admit(key: string, wake: unknown): "start" | "coalesced"
  finish(key: string): unknown
  release(key: string): void
}
export function handleWake(
  http: { method?: string; body: string; timestamp?: string; signature?: string },
  deps: {
    config: { webhookSecret: string; agentName: string; mcpUrl?: string; bearerToken?: string }
    seenSignatures: Map<string, number>
    seenDeliveries: Map<string, number>
    lane: { admit(key: string, wake: unknown): "start" | "coalesced"; finish(key: string): unknown; release(key: string): void }
    now?: number
    pendingDir?: string
    sleep?: (ms: number) => Promise<void>
    start: (wake: any, config: unknown, prompt: string) => Promise<{ status: number; body?: unknown }>
    markRead?: (config: unknown, wake: any) => Promise<void>
    reportFailure?: (config: unknown, wake: any) => Promise<boolean>
    accept?: (wake: { roomId?: string; agentId?: string; deliveryId?: string }) => "missing" | "duplicate" | "fresh"
  },
): Promise<{ status: number; body: Record<string, unknown>; done: Promise<void> }>
export const maxHarnessAttempts: number
export function harnessRetryDelayMs(attemptsSoFar: number): number
export function failureBody(wake: { fromSeq: number; toSeq: number }): string
export function readPendingFile(dir: string, roomId: string, agentId: string): PendingRecord | undefined
export function writePendingFile(dir: string, roomId: string, agentId: string, record: PendingRecord): void
export function removePendingFile(dir: string, roomId: string, agentId: string): void
export function acceptPending(dir: string, wake: { roomId: string; agentId: string; deliveryId: string }): "start" | "queued" | "same"
export function markDelivered(
  config: { mcpUrl?: string; bearerToken?: string },
  wake: { roomId?: string; toSeq?: number; sinceCursor?: number },
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>,
): Promise<void>
export function postFailure(
  config: { mcpUrl?: string; bearerToken?: string },
  wake: { roomId: string; fromSeq: number; toSeq: number },
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; text(): Promise<string> }>,
): Promise<boolean>
export function resumeUnfinished(
  dir: string,
  deps: {
    config: { agentName: string; mcpUrl?: string; bearerToken?: string }
    lane: { admit(key: string, wake: unknown): "start" | "coalesced"; release(key: string): void }
    pendingDir?: string
    start: (wake: any, config: unknown, prompt: string) => Promise<{ status: number; body?: unknown }>
    markRead?: (config: unknown, wake: any) => Promise<void>
    reportFailure?: (config: unknown, wake: any) => Promise<boolean>
    sleep?: (ms: number) => Promise<void>
  },
): Promise<void>
export type PendingPhase = "queued" | "running" | "retry" | "succeeded" | "exhausted" | "reported"
export type PendingRecord = {
  wake: any
  attempts: number
  phase: PendingPhase
  followUp: any
}
export function writeSessionFile(dir: string, roomId: string, agentId: string, sessionId: string): void
export function readSessionFile(dir: string, roomId: string, agentId: string): string | undefined
export function replaceFile(
  tmp: string,
  dest: string,
  fsImpl?: { renameSync: (from: string, to: string) => void; rmSync: (path: string, options?: { force?: boolean }) => void },
): void
export function recordDelivery(
  dir: string,
  roomId: string,
  agentId: string,
  deliveryId: string,
  now: number,
): "missing" | "duplicate" | "fresh"
export function findSessionId(stdout: string): string | undefined
export function codexArgs(extraArgs: ReadonlyArray<string>, previous: string | undefined, prompt: string): Array<string>
export function spawnHarness(input: {
  bin: string
  args: ReadonlyArray<string>
  cwd: string
  env: Record<string, string | undefined>
}): Promise<{ status: number; body: { ok: boolean; code?: number | null; stdout?: string; stderr?: string; message?: string } }>
