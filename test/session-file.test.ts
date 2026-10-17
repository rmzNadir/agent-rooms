import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { readSessionFile, recordDelivery, replaceFile, writeSessionFile } from "../listeners/common.mjs"

test("two rooms keep their own session files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-rooms-sessions-"))
  writeSessionFile(dir, "room_aaaaaaaaaaaaaaaaaaaaaaaa", "agent_aaaaaaaaaaaaaaaaaaaaaaaa", "ses_a")
  writeSessionFile(dir, "room_bbbbbbbbbbbbbbbbbbbbbbbb", "agent_aaaaaaaaaaaaaaaaaaaaaaaa", "ses_b")
  writeSessionFile(dir, "room_aaaaaaaaaaaaaaaaaaaaaaaa", "agent_bbbbbbbbbbbbbbbbbbbbbbbb", "ses_c")
  expect(readSessionFile(dir, "room_aaaaaaaaaaaaaaaaaaaaaaaa", "agent_aaaaaaaaaaaaaaaaaaaaaaaa")).toBe("ses_a")
  expect(readSessionFile(dir, "room_bbbbbbbbbbbbbbbbbbbbbbbb", "agent_aaaaaaaaaaaaaaaaaaaaaaaa")).toBe("ses_b")
  expect(readSessionFile(dir, "room_aaaaaaaaaaaaaaaaaaaaaaaa", "agent_bbbbbbbbbbbbbbbbbbbbbbbb")).toBe("ses_c")
})

test("a delivery id is remembered for that room and agent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-rooms-deliveries-"))
  const now = Date.now()
  expect(recordDelivery(dir, "room_aaaaaaaaaaaaaaaaaaaaaaaa", "agent_aaaaaaaaaaaaaaaaaaaaaaaa", "dlv_1", now)).toBe("fresh")
  expect(recordDelivery(dir, "room_aaaaaaaaaaaaaaaaaaaaaaaa", "agent_aaaaaaaaaaaaaaaaaaaaaaaa", "dlv_1", now + 1)).toBe("duplicate")
  expect(recordDelivery(dir, "room_bbbbbbbbbbbbbbbbbbbbbbbb", "agent_aaaaaaaaaaaaaaaaaaaaaaaa", "dlv_1", now + 1)).toBe("fresh")
})

test("a failed rename removes the destination and retries", () => {
  const calls: string[] = []
  let renamed = 0
  replaceFile(
    "tmp",
    "dest",
    {
      renameSync: () => {
        renamed += 1
        calls.push(`rename-${renamed}`)
        if (renamed === 1) throw new Error("EPERM")
      },
      rmSync: () => {
        calls.push("rm")
      },
    },
  )
  expect(calls).toEqual(["rename-1", "rm", "rename-2"])
})
