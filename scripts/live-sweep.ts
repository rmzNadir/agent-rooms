import { leftoverName } from "./live-checks.ts";
import { agentList, roomHeads } from "./room-parse.ts";
import { readPayload } from "./snapshot-diff.ts";

export interface SweepIo {
  readonly admin: string;
  readonly base: string;
  readonly request: (
    method: string,
    url: string,
    token: string,
    body?: string
  ) => Promise<{ readonly status: number; readonly text: string }>;
}

export interface SweepTarget {
  readonly id: string;
  readonly path: string;
}

const rowsOf = (text: string) => readPayload(text);

export const sweepTargets = (
  agents: readonly { readonly agentId: string; readonly displayName: string }[],
  rooms: readonly { readonly name: string; readonly roomId: string }[],
  keep: readonly string[]
): readonly SweepTarget[] => [
  ...agents
    .filter((agent) => leftoverName(agent.displayName, keep))
    .map((agent) => ({ id: agent.agentId, path: "admin/agents" })),
  ...rooms
    .filter((room) => leftoverName(room.name, keep))
    .map((room) => ({ id: room.roomId, path: "admin/rooms" })),
];

const dropOne = async (io: SweepIo, target: SweepTarget) => {
  const reply = await io.request(
    "DELETE",
    `${io.base}/${target.path}/${target.id}`,
    io.admin
  );
  if (reply.status !== 200) {
    throw new Error(`delete ${target.path} failed ${reply.status}`);
  }
};

export const sweepLive = async (io: SweepIo, keep: readonly string[]) => {
  const agentsReply = await io.request(
    "GET",
    `${io.base}/admin/agents`,
    io.admin
  );
  const roomsReply = await io.request("GET", `${io.base}/api/rooms`, io.admin);
  if (agentsReply.status !== 200 || roomsReply.status !== 200) {
    throw new Error(
      `list leftovers failed ${agentsReply.status} ${roomsReply.status}`
    );
  }
  const agents = agentList(rowsOf(agentsReply.text)) ?? [];
  const rooms = roomHeads(rowsOf(roomsReply.text)) ?? [];
  const targets = sweepTargets(agents, rooms, keep);
  await Promise.all(targets.map((target) => dropOne(io, target)));
};
