import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { readSessionFile, replaceFile, writeSessionFile } from "../listeners/common.mjs"

test("two rooms keep their own session files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-rooms-sessions-"))
  writeSessionFile(dir, "room_aaaaaaaaaaaaaaaaaaaaaaaa", "agent_aaaaaaaaaaaaaaaaaaaaaaaa", "ses_a")
  writeSessionFile(dir, "room_bbbbbbbbbbbbbbbbbbbbbbbb", "agent_aaaaaaaaaaaaaaaaaaaaaaaa", "ses_b")
  writeSessionFile(dir, "room_aaaaaaaaaaaaaaaaaaaaaaaa", "agent_bbbbbbbbbbbbbbbbbbbbbbbb", "ses_c")
  expect(readSessionFile(dir, "room_aaaaaaaaaaaaaaaaaaaaaaaa", "agent_aaaaaaaaaaaaaaaaaaaaaaaa")).toBe("ses_a")
  expect(readSessionFile(dir, "room_bbbbbbbbbbbbbbbbbbbbbbbb", "agent_aaaaaaaaaaaaaaaaaaaaaaaa")).toBe("ses_b")
  expect(readSessionFile(dir, "room_aaaaaaaaaaaaaaaaaaaaaaaa", "agent_bbbbbbbbbbbbbbbbbbbbbbbb")).toBe("ses_c")
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
