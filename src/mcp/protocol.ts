export const supportedProtocolVersions = ["2026-07-28", "2025-11-25", "2025-06-18"] as const

export type SupportedProtocolVersion = (typeof supportedProtocolVersions)[number]

export const protocolVersionMetaKey = "io.modelcontextprotocol/protocolVersion"

export const isSupportedProtocolVersion = (value: string): value is SupportedProtocolVersion =>
  (supportedProtocolVersions as readonly string[]).includes(value)

export const modernProtocolVersions = supportedProtocolVersions.filter((version) => version >= "2026-01-01")

const idOf = (value: unknown): string | number | null => {
  if (value === null) return null
  if (typeof value === "string" || typeof value === "number") return value
  return null
}

export type VersionRejection = {
  readonly id: string | number | null
  readonly requested: string
}

const rejectionFrom = (parsed: unknown, protocolHeader: string | null): VersionRejection | undefined => {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const message = parsed as { id?: unknown; method?: unknown; params?: unknown }
  const params =
    message.params !== null && typeof message.params === "object" && !Array.isArray(message.params)
      ? (message.params as Record<string, unknown>)
      : undefined
  const meta = params?._meta
  const metaObject =
    meta !== null && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : undefined
  const metaVersion = metaObject?.[protocolVersionMetaKey]
  const initVersion = message.method === "initialize" ? params?.protocolVersion : undefined
  const declared = [protocolHeader, metaVersion, initVersion].filter(
    (version): version is string => typeof version === "string" && version.length > 0,
  )
  const requested = declared.find((version) => !isSupportedProtocolVersion(version))
  if (requested === undefined) return undefined
  return { id: idOf(message.id), requested }
}

export const versionRejection = (bodyText: string, protocolHeader: string | null): VersionRejection | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return rejectionFrom(parsed, protocolHeader)
  for (const item of parsed) {
    const rejection = rejectionFrom(item, protocolHeader)
    if (rejection !== undefined) return rejection
  }
  return undefined
}

export const unsupportedProtocolVersionBody = (rejection: VersionRejection) => ({
  jsonrpc: "2.0",
  id: rejection.id,
  error: {
    code: -32022,
    message: "Unsupported protocol version",
    data: { supported: [...supportedProtocolVersions], requested: rejection.requested },
  },
})
