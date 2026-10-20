import { expect, test } from "bun:test";
import { liveKeep } from "../scripts/live-checks.ts";
import { type LiveIo, runLive } from "../scripts/live-e2e.ts";
import { type SweepIo, sweepLive } from "../scripts/live-sweep.ts";

const reply = (status: number, text: string) =>
  Promise.resolve({ status, text });

const agentRow = (agentId: string, displayName: string) => ({
  admin: false,
  agentId,
  displayName,
  kind: "agent",
});

const roomRow = (roomId: string, name: string) => ({
  leadId: "agent_aaaaaaaaaaaaaaaaaaaaaaaa",
  name,
  roomId,
  topic: "",
});

const ioOf = (request: SweepIo["request"]): LiveIo => ({
  admin: "admin-token",
  base: "https://rooms.example",
  down: () => Promise.resolve(),
  now: () => 0,
  request,
  sleep: () => Promise.resolve(),
  socket: () =>
    Promise.resolve({
      closeCode: Promise.resolve(1000),
      opened: Promise.resolve(),
    }),
  suffix: "abc123",
  up: () => Promise.resolve("https://receiver.example"),
});

const listing = (agents: string, rooms: string, deleted: string[]) => {
  const request: SweepIo["request"] = (method, url) => {
    const path = new URL(url).pathname;
    if (method === "DELETE") {
      deleted.push(path);
      return reply(200, '{"ok":true}');
    }
    if (path === "/admin/agents") {
      return reply(200, agents);
    }
    return reply(200, rooms);
  };
  return request;
};

test("sweep drops leftover names and keeps the current run", async () => {
  const deleted: string[] = [];
  const agents = JSON.stringify([
    agentRow("agent_aaaaaaaaaaaaaaaaaaaaaaaa", "e2ea394456"),
    agentRow("agent_bbbbbbbbbbbbbbbbbbbbbbbb", "a394456"),
    agentRow("agent_cccccccccccccccccccccccc", "brobert"),
    agentRow("agent_dddddddddddddddddddddddd", "e2eaabc123"),
  ]);
  const rooms = JSON.stringify([
    roomRow("room_aaaaaaaaaaaaaaaaaaaaaaaa", "e2erelay394456"),
    roomRow("room_bbbbbbbbbbbbbbbbbbbbbbbb", "wake394456"),
    roomRow("room_cccccccccccccccccccccccc", "general"),
    roomRow("room_dddddddddddddddddddddddd", "e2ewakeabc123"),
  ]);
  await sweepLive(ioOf(listing(agents, rooms, deleted)), liveKeep("abc123"));
  const byPath = (left: string, right: string) => left.localeCompare(right);
  expect([...deleted].sort(byPath)).toEqual(
    [
      "/admin/agents/agent_aaaaaaaaaaaaaaaaaaaaaaaa",
      "/admin/agents/agent_bbbbbbbbbbbbbbbbbbbbbbbb",
      "/admin/rooms/room_aaaaaaaaaaaaaaaaaaaaaaaa",
      "/admin/rooms/room_bbbbbbbbbbbbbbbbbbbbbbbb",
    ].sort(byPath)
  );
});

test("sweep treats a non-list body as empty", async () => {
  await sweepLive(
    ioOf(() => reply(200, '{"ok":true}')),
    []
  );
});

test("sweep reports a failed directory list", async () => {
  await expect(
    sweepLive(
      ioOf(() => reply(500, "")),
      []
    )
  ).rejects.toThrow("list leftovers failed 500 500");
});

test("sweep reports a failed delete", async () => {
  const agents = JSON.stringify([
    agentRow("agent_aaaaaaaaaaaaaaaaaaaaaaaa", "e2eold"),
  ]);
  const request: SweepIo["request"] = (method, url) => {
    if (method === "DELETE") {
      return reply(400, "");
    }
    if (new URL(url).pathname === "/admin/agents") {
      return reply(200, agents);
    }
    return reply(200, "[]");
  };
  await expect(sweepLive(ioOf(request), [])).rejects.toThrow(
    "delete admin/agents failed 400"
  );
});

test("a failed run still deletes the current throwaway agent", async () => {
  const deleted: string[] = [];
  const agents = JSON.stringify([
    agentRow("agent_aaaaaaaaaaaaaaaaaaaaaaaa", "e2eaabc123"),
  ]);
  const io = {
    ...ioOf(listing(agents, "[]", deleted)),
    up: () => Promise.reject(new Error("upload failed")),
  };
  await expect(runLive(io)).rejects.toThrow("upload failed");
  expect(deleted).toEqual(["/admin/agents/agent_aaaaaaaaaaaaaaaaaaaaaaaa"]);
});
