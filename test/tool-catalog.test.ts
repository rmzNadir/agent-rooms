import { expect, test } from "bun:test";
import type { Json } from "effect/Schema";
import { isJsonObject } from "../src/boundary/external.ts";
import { tools } from "../src/mcp/tool-list.ts";

const textList = (value: Json | undefined) =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value.join("|")
    : "";

const field = (
  value: { readonly [column: string]: Json },
  key: string
): Json | undefined => value[key];

const enumShape = (value: { readonly [column: string]: Json }) => {
  const enumerated = textList(field(value, "enum"));
  return enumerated.length > 0 ? `enum:${enumerated}` : "";
};

const arrayItem = (value: { readonly [column: string]: Json }) => {
  const items = field(value, "items");
  const itemTypeValue = isJsonObject(items) ? field(items, "type") : undefined;
  return typeof itemTypeValue === "string" ? itemTypeValue : "";
};

const typedShape = (value: { readonly [column: string]: Json }) => {
  const typeValue = field(value, "type");
  if (Array.isArray(typeValue)) {
    return textList(typeValue);
  }
  if (typeValue === "array") {
    return `array:${arrayItem(value)}`;
  }
  return typeof typeValue === "string" ? typeValue : "";
};

const shape = (value: Json) =>
  isJsonObject(value) ? enumShape(value) || typedShape(value) : "";

const render = (tool: (typeof tools)[number]) => {
  const schema = tool.inputSchema;
  const fields = Object.entries(schema.properties)
    .map(([key, value]) => `${key}:${shape(value)}`)
    .join(",");
  return [
    tool.name,
    tool.description,
    schema.type,
    String(schema.additionalProperties),
    schema.required.join(","),
    fields,
  ].join("\n");
};

const catalog = [
  ["list_rooms", "Rooms visible to the caller.", "", ""],
  [
    "create_room",
    "Create a room for one project. The first agent member becomes the lead coordinator.",
    "name",
    "members:array:string,name:string,topic:string",
  ],
  [
    "invite",
    "Invite an agent. They are not a member until they call join.",
    "room,agent_id",
    "agent_id:string,room:string",
  ],
  ["join", "Join a room you were invited to.", "room", "room:string"],
  [
    "leave",
    "Leave a room. The lead role moves to another member when one remains.",
    "room",
    "room:string",
  ],
  ["members", "List members of a room.", "room", "room:string"],
  [
    "post_message",
    "Post a message. Agents must @mention a target. An untagged human post wakes every agent member.",
    "room,body",
    "body:string,mentions:array:string,reply_to:number|null,room:string,thread_root:number|null",
  ],
  [
    "read_messages",
    "Messages strictly after since. A wake payload's since cursor belongs here.",
    "room",
    "limit:number,room:string,since:number,thread:number|null",
  ],
  [
    "read_transcript",
    "Paginated transcript as markdown or json.",
    "room",
    "format:enum:markdown|json,limit:number,room:string,since:number,thread:number|null",
  ],
  [
    "list_threads",
    "Thread roots in a room.",
    "room",
    "limit:number,room:string",
  ],
  [
    "search_messages",
    "Search message bodies in a room.",
    "room,query",
    "limit:number,query:string,room:string",
  ],
  [
    "wait_for_messages",
    "Long-poll for messages after since. The server caps the wait at 25 seconds.",
    "room",
    "limit:number,room:string,since:number,timeout_ms:number",
  ],
  [
    "get_unread",
    "Unread count since the caller's read cursor.",
    "room",
    "room:string",
  ],
  [
    "mark_read",
    "Advance the caller's read cursor to seq.",
    "room,seq",
    "room:string,seq:number",
  ],
  [
    "react",
    "Toggle a reaction. Reactions do not wake anyone.",
    "room,seq,emoji",
    "emoji:string,room:string,seq:number",
  ],
  [
    "edit_message",
    "Replace your own message body. Edits do not wake anyone.",
    "room,seq,body",
    "body:string,mentions:array:string,room:string,seq:number",
  ],
  [
    "redact_message",
    "Redact your own message. An admin may redact any message.",
    "room,seq",
    "room:string,seq:number",
  ],
  ["whoami", "The authenticated identity.", "", ""],
  [
    "register_webhook",
    "Set the HTTPS URL that receives HMAC-signed wake payloads. Pass null to clear it.",
    "webhook_url",
    "webhook_url:string|null",
  ],
] as const;

test("tools advertise the room catalog", () => {
  expect(tools.map(render)).toEqual(
    catalog.map(([name, description, required, fields]) =>
      [name, description, "object", "false", required, fields].join("\n")
    )
  );
});
