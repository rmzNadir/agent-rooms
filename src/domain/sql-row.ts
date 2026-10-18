export type SqlCell = string | number | null | undefined;

const cell = (
  row: { readonly [key: string]: string | number | null },
  key: string
): SqlCell => row[key];

export const sqlRow = (row: {
  readonly [key: string]: string | number | null;
}): SqlRow => ({
  admin: cell(row, "admin"),
  agent_id: cell(row, "agent_id"),
  attempts: cell(row, "attempts"),
  author_id: cell(row, "author_id"),
  author_kind: cell(row, "author_kind"),
  author_name: cell(row, "author_name"),
  body: cell(row, "body"),
  created_at: cell(row, "created_at"),
  delivery_id: cell(row, "delivery_id"),
  display_name: cell(row, "display_name"),
  edited_at: cell(row, "edited_at"),
  emoji: cell(row, "emoji"),
  from_seq: cell(row, "from_seq"),
  hop_count: cell(row, "hop_count"),
  id: cell(row, "id"),
  joined: cell(row, "joined"),
  kind: cell(row, "kind"),
  last_delivered_at: cell(row, "last_delivered_at"),
  last_read_seq: cell(row, "last_read_seq"),
  last_seq: cell(row, "last_seq"),
  lead_id: cell(row, "lead_id"),
  mentions_json: cell(row, "mentions_json"),
  message_ids_json: cell(row, "message_ids_json"),
  n: cell(row, "n"),
  name: cell(row, "name"),
  not_before: cell(row, "not_before"),
  paused: cell(row, "paused"),
  preview: cell(row, "preview"),
  redacted: cell(row, "redacted"),
  replies: cell(row, "replies"),
  reply_to: cell(row, "reply_to"),
  role: cell(row, "role"),
  room_id: cell(row, "room_id"),
  root: cell(row, "root"),
  seq: cell(row, "seq"),
  since_seq: cell(row, "since_seq"),
  thread_root: cell(row, "thread_root"),
  to_seq: cell(row, "to_seq"),
  token_hash: cell(row, "token_hash"),
  topic: cell(row, "topic"),
  wake_seq: cell(row, "wake_seq"),
  webhook_secret: cell(row, "webhook_secret"),
  webhook_url: cell(row, "webhook_url"),
});

export interface SqlRow {
  readonly admin: SqlCell;
  readonly agent_id: SqlCell;
  readonly attempts: SqlCell;
  readonly author_id: SqlCell;
  readonly author_kind: SqlCell;
  readonly author_name: SqlCell;
  readonly body: SqlCell;
  readonly created_at: SqlCell;
  readonly delivery_id: SqlCell;
  readonly display_name: SqlCell;
  readonly edited_at: SqlCell;
  readonly emoji: SqlCell;
  readonly from_seq: SqlCell;
  readonly hop_count: SqlCell;
  readonly id: SqlCell;
  readonly joined: SqlCell;
  readonly kind: SqlCell;
  readonly last_delivered_at: SqlCell;
  readonly last_read_seq: SqlCell;
  readonly last_seq: SqlCell;
  readonly lead_id: SqlCell;
  readonly mentions_json: SqlCell;
  readonly message_ids_json: SqlCell;
  readonly n: SqlCell;
  readonly name: SqlCell;
  readonly not_before: SqlCell;
  readonly paused: SqlCell;
  readonly preview: SqlCell;
  readonly redacted: SqlCell;
  readonly replies: SqlCell;
  readonly reply_to: SqlCell;
  readonly role: SqlCell;
  readonly room_id: SqlCell;
  readonly root: SqlCell;
  readonly seq: SqlCell;
  readonly since_seq: SqlCell;
  readonly thread_root: SqlCell;
  readonly to_seq: SqlCell;
  readonly token_hash: SqlCell;
  readonly topic: SqlCell;
  readonly wake_seq: SqlCell;
  readonly webhook_secret: SqlCell;
  readonly webhook_url: SqlCell;
}
