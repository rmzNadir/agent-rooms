export const socketIdsForAgent = (
  sessions: ReadonlyArray<{ readonly id: string; readonly agentId: string }>,
  agentId: string
): readonly string[] =>
  sessions
    .filter((session) => session.agentId === agentId)
    .map((session) => session.id);
