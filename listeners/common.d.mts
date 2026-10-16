export function verifySignature(secret: string, timestamp: string, body: string, header: string): boolean
export function rememberSignature(seen: Map<string, number>, signature: string, now: number): boolean
