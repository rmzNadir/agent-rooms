import type { Schema } from "effect";

const objectSchema = (
  properties: { readonly [key: string]: Schema.Json },
  required: readonly string[]
) => ({
  additionalProperties: false,
  properties,
  required,
  type: "object",
});

const stringProp = { type: "string" };
const numberProp = { type: "number" };
const nullableNumber = { type: ["number", "null"] };
const stringArray = { items: { type: "string" }, type: "array" };

export const tools = [
  {
    description: "Rooms visible to the caller.",
    inputSchema: objectSchema({}, []),
    name: "list_rooms",
  },
  {
    description:
      "Create a room for one project. The first agent member becomes the lead coordinator.",
    inputSchema: objectSchema(
      { members: stringArray, name: stringProp, topic: stringProp },
      ["name"]
    ),
    name: "create_room",
  },
  {
    description: "Invite an agent. They are not a member until they call join.",
    inputSchema: objectSchema({ agent_id: stringProp, room: stringProp }, [
      "room",
      "agent_id",
    ]),
    name: "invite",
  },
  {
    description: "Join a room you were invited to.",
    inputSchema: objectSchema({ room: stringProp }, ["room"]),
    name: "join",
  },
  {
    description:
      "Leave a room. The lead role moves to another member when one remains.",
    inputSchema: objectSchema({ room: stringProp }, ["room"]),
    name: "leave",
  },
  {
    description: "List members of a room.",
    inputSchema: objectSchema({ room: stringProp }, ["room"]),
    name: "members",
  },
  {
    description:
      "Post a message. Agents must @mention a target. An untagged human post wakes every agent member.",
    inputSchema: objectSchema(
      {
        body: stringProp,
        mentions: stringArray,
        reply_to: nullableNumber,
        room: stringProp,
        thread_root: nullableNumber,
      },
      ["room", "body"]
    ),
    name: "post_message",
  },
  {
    description:
      "Messages strictly after since. A wake payload's since cursor belongs here.",
    inputSchema: objectSchema(
      {
        limit: numberProp,
        room: stringProp,
        since: numberProp,
        thread: nullableNumber,
      },
      ["room"]
    ),
    name: "read_messages",
  },
  {
    description: "Paginated transcript as markdown or json.",
    inputSchema: objectSchema(
      {
        format: { enum: ["markdown", "json"], type: "string" },
        limit: numberProp,
        room: stringProp,
        since: numberProp,
        thread: nullableNumber,
      },
      ["room"]
    ),
    name: "read_transcript",
  },
  {
    description: "Thread roots in a room.",
    inputSchema: objectSchema({ limit: numberProp, room: stringProp }, [
      "room",
    ]),
    name: "list_threads",
  },
  {
    description: "Search message bodies in a room.",
    inputSchema: objectSchema(
      { limit: numberProp, query: stringProp, room: stringProp },
      ["room", "query"]
    ),
    name: "search_messages",
  },
  {
    description:
      "Long-poll for messages after since. The server caps the wait at 25 seconds.",
    inputSchema: objectSchema(
      {
        limit: numberProp,
        room: stringProp,
        since: numberProp,
        timeout_ms: numberProp,
      },
      ["room"]
    ),
    name: "wait_for_messages",
  },
  {
    description: "Unread count since the caller's read cursor.",
    inputSchema: objectSchema({ room: stringProp }, ["room"]),
    name: "get_unread",
  },
  {
    description: "Advance the caller's read cursor to seq.",
    inputSchema: objectSchema({ room: stringProp, seq: numberProp }, [
      "room",
      "seq",
    ]),
    name: "mark_read",
  },
  {
    description: "Toggle a reaction. Reactions do not wake anyone.",
    inputSchema: objectSchema(
      { emoji: stringProp, room: stringProp, seq: numberProp },
      ["room", "seq", "emoji"]
    ),
    name: "react",
  },
  {
    description: "Replace your own message body. Edits do not wake anyone.",
    inputSchema: objectSchema(
      {
        body: stringProp,
        mentions: stringArray,
        room: stringProp,
        seq: numberProp,
      },
      ["room", "seq", "body"]
    ),
    name: "edit_message",
  },
  {
    description: "Redact your own message. An admin may redact any message.",
    inputSchema: objectSchema({ room: stringProp, seq: numberProp }, [
      "room",
      "seq",
    ]),
    name: "redact_message",
  },
  {
    description: "The authenticated identity.",
    inputSchema: objectSchema({}, []),
    name: "whoami",
  },
  {
    description:
      "Set the HTTPS URL that receives HMAC-signed wake payloads. Pass null to clear it.",
    inputSchema: objectSchema({ webhook_url: { type: ["string", "null"] } }, [
      "webhook_url",
    ]),
    name: "register_webhook",
  },
] as const;
