export type AdminDecision = "bootstrap" | "accept" | "reject"

/**
 * The stored admin hash is the credential after the first login.
 * The env token bootstraps that row and keeps working only while it matches the stored hash.
 * Rotating the stored hash revokes the env token until the operator saves the new one.
 */
export const decideAdmin = (input: {
  readonly presentedHash: string
  readonly envHash: string
  readonly storedHash: string | undefined
}): AdminDecision => {
  if (input.storedHash === undefined) {
    return input.presentedHash === input.envHash ? "bootstrap" : "reject"
  }
  return input.presentedHash === input.storedHash ? "accept" : "reject"
}
