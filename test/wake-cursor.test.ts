import { expect, test } from "bun:test"
import { clampCursor, extendSpan, openSpan, spanFromRow } from "../src/domain/wake-cursor.ts"

test("a new wake starts at the delivered cursor and ends at the new message", () => {
  expect(openSpan(4, 9, "dlv_a")).toEqual({ fromSeq: 4, toSeq: 9, deliveryId: "dlv_a" })
})

test("a mention during an open wake keeps the start and takes the later end", () => {
  const opened = openSpan(4, 9, "dlv_a")
  expect(extendSpan(opened, 12, "dlv_b")).toEqual({ fromSeq: 4, toSeq: 12, deliveryId: "dlv_b" })
  expect(extendSpan(opened, 3, "dlv_c").toSeq).toBe(9)
})

test("an old outbox row uses sinceSeq only when it never recorded an end", () => {
  expect(spanFromRow({ fromSeq: 0, toSeq: 0, sinceSeq: 12 })).toEqual({ fromSeq: 12, toSeq: 0 })
  expect(spanFromRow({ fromSeq: 0, toSeq: 9, sinceSeq: 0 })).toEqual({ fromSeq: 0, toSeq: 9 })
})

test("a read cursor moves forward and never past the latest seq", () => {
  expect(clampCursor(0, 9, 5)).toBe(5)
  expect(clampCursor(4, 2, 9)).toBe(4)
  expect(clampCursor(1, 3, 9)).toBe(3)
})
