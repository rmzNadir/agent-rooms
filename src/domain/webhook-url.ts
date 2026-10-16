const loopbackNames = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

const ipv4 = (host: string): ReadonlyArray<number> | undefined => {
  const parts = host.split(".")
  if (parts.length !== 4) return undefined
  const nums: number[] = []
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return undefined
    const value = Number(part)
    if (value > 255) return undefined
    nums.push(value)
  }
  return nums
}

const privateOrReserved = (nums: ReadonlyArray<number>): boolean => {
  const a = nums[0] ?? 0
  const b = nums[1] ?? 0
  if (a === 10 || a === 127 || a === 0 || a >= 224) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

export const webhookUrlProblem = (value: string): string | undefined => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return "must be an http or https URL"
  }
  if (url.username.length > 0 || url.password.length > 0) return "must not include a username or password"
  const host = url.hostname.toLowerCase()
  const dotted = /^[0-9.]+$/.test(host)
  const address = dotted ? ipv4(host) : undefined
  if (dotted && address === undefined) return "must not target a private or link-local address"
  const loopback = loopbackNames.has(host) || (address !== undefined && address.join(".") === "127.0.0.1")
  if (host.includes(":") && !loopback) return "must not target a private or link-local address"
  if (address !== undefined && privateOrReserved(address) && !loopback) {
    return "must not target a private or link-local address"
  }
  if (url.protocol === "https:") return undefined
  if (url.protocol === "http:" && loopback) return undefined
  return "must be https, or http on localhost"
}
