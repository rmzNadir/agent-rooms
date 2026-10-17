export function verifySignature(secret: string, timestamp: string, body: string, header: string): boolean
export function rememberSignature(seen: Map<string, number>, signature: string, now: number): boolean
export function signatureDigest(header: string): string
export function acceptDelivery(seen: Map<string, number>, deliveryId: string, now: number, ttl?: number): "missing" | "duplicate" | "fresh"
export function createLane(): {
  admit(key: string, wake: unknown): "start" | "coalesced"
  finish(key: string): unknown
}
export function handleWake(
  http: { method?: string; body: string; timestamp?: string; signature?: string },
  deps: {
    config: { webhookSecret: string; agentName: string; mcpUrl?: string; bearerToken?: string }
    seenSignatures: Map<string, number>
    seenDeliveries: Map<string, number>
    lane: { admit(key: string, wake: unknown): "start" | "coalesced"; finish(key: string): unknown }
    now?: number
    start: (wake: any, config: unknown, prompt: string) => Promise<{ status: number; body?: unknown }>
    markRead?: (config: unknown, wake: any) => Promise<void>
    accept?: (wake: { roomId?: string; agentId?: string; deliveryId?: string }) => "missing" | "duplicate" | "fresh"
  },
): Promise<{ status: number; body: Record<string, unknown>; done: Promise<void> }>
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
