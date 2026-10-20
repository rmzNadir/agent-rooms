export const inviteAllowed = (actorJoined: boolean, admin: boolean) =>
  actorJoined || admin;

export const invitedMember = <T>(member: T | undefined): member is T =>
  member !== undefined;

export const nextLead = <T extends { readonly kind: "agent" | "human" }>(
  role: "lead" | "member",
  remaining: readonly T[]
): T | undefined =>
  role === "lead"
    ? (remaining.find((item) => item.kind === "agent") ?? remaining[0])
    : undefined;
