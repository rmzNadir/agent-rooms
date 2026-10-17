export type WakeSpan = {
  readonly fromSeq: number
  readonly toSeq: number
  readonly deliveryId: string
}

export const openSpan = (wakeSeq: number, messageSeq: number, deliveryId: string): WakeSpan => ({
  fromSeq: wakeSeq,
  toSeq: messageSeq,
  deliveryId,
})

export const extendSpan = (span: WakeSpan, messageSeq: number, deliveryId: string): WakeSpan => ({
  fromSeq: span.fromSeq,
  toSeq: messageSeq > span.toSeq ? messageSeq : span.toSeq,
  deliveryId,
})

export const spanFromRow = (row: {
  readonly fromSeq: number
  readonly toSeq: number
  readonly sinceSeq: number
}): { readonly fromSeq: number; readonly toSeq: number } => ({
  fromSeq: row.toSeq === 0 && row.fromSeq === 0 ? row.sinceSeq : row.fromSeq,
  toSeq: row.toSeq,
})

export const clampCursor = (current: number, requested: number, latest: number): number => {
  const floor = requested > current ? requested : current
  return floor > latest ? latest : floor
}
