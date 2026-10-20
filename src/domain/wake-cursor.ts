export interface WakeSpan {
  readonly deliveryId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
}

export const openSpan = (
  wakeSeq: number,
  messageSeq: number,
  deliveryId: string
): WakeSpan => ({
  deliveryId,
  fromSeq: wakeSeq,
  toSeq: messageSeq,
});

export const extendSpan = (
  span: WakeSpan,
  messageSeq: number,
  deliveryId: string
): WakeSpan => ({
  deliveryId,
  fromSeq: span.fromSeq,
  toSeq: Math.max(messageSeq, span.toSeq),
});

export const spanFromRow = (row: {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly sinceSeq: number;
}): { readonly fromSeq: number; readonly toSeq: number } => ({
  fromSeq: row.toSeq === 0 && row.fromSeq === 0 ? row.sinceSeq : row.fromSeq,
  toSeq: row.toSeq,
});

export const clampCursor = (
  current: number,
  requested: number,
  latest: number
): number => Math.min(Math.max(requested, current), latest);
