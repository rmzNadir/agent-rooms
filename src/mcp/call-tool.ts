import { Effect, Schema } from "effect";
import type { Json } from "effect/Schema";
import { Chat, type ChatError, type IChat } from "../app/chat.ts";
import { at, encodeJsonText } from "../boundary/external.ts";
import type { Actor } from "../domain/actor.ts";
import { InvalidArgument, publicErrorBody } from "../domain/errors.ts";
import { AgentId, type RequestId, RoomId } from "../domain/ids.ts";

const optionalJson = Schema.optional(Schema.Json);
const Args = Schema.Struct({
  agent_id: optionalJson,
  body: optionalJson,
  emoji: optionalJson,
  format: optionalJson,
  limit: optionalJson,
  members: optionalJson,
  mentions: optionalJson,
  name: optionalJson,
  query: optionalJson,
  reply_to: optionalJson,
  room: optionalJson,
  seq: optionalJson,
  since: optionalJson,
  thread: optionalJson,
  thread_root: optionalJson,
  timeout_ms: optionalJson,
  topic: optionalJson,
  webhook_url: optionalJson,
});

const unavailableJson =
  '{"code":"Unavailable","message":"The response could not be encoded. Retry the same request.","details":{},"requestId":"req_000000000000000000000001","retryable":true}';

export const jsonText = <A>(value: A) =>
  Effect.catchTag(encodeJsonText(value), "SchemaError", () =>
    Effect.succeed(unavailableJson)
  );

interface ToolBody {
  readonly content: ReadonlyArray<{
    readonly type: "text";
    readonly text: string;
  }>;
  readonly isError: boolean;
}

const toolOk = <A>(value: A) =>
  Effect.map(
    jsonText(value),
    (text): ToolBody => ({ content: [{ text, type: "text" }], isError: false })
  );

export const toolErr = (error: {
  readonly code: string;
  readonly message: string;
  readonly details: object;
  readonly requestId: RequestId;
  readonly retryable: boolean;
}) =>
  Effect.map(
    jsonText(publicErrorBody(error)),
    (text): ToolBody => ({ content: [{ text, type: "text" }], isError: true })
  );

const asTool = <A>(effect: Effect.Effect<A, ChatError>) =>
  Effect.catchTags(Effect.flatMap(effect, toolOk), {
    AgentNotFound: toolErr,
    Forbidden: toolErr,
    InvalidArgument: toolErr,
    LeadRequired: toolErr,
    MentionRequired: toolErr,
    MessageNotFound: toolErr,
    NotAuthor: toolErr,
    NotInvited: toolErr,
    NotMember: toolErr,
    PersistenceFailed: toolErr,
    RoomNameTaken: toolErr,
    RoomNotFound: toolErr,
    SelfMentionOnly: toolErr,
    Unauthorized: toolErr,
    Unavailable: toolErr,
    UnknownMention: toolErr,
  });

const invalid = (requestId: RequestId, field: string, constraint: string) =>
  new InvalidArgument({
    code: "InvalidArgument",
    details: { constraint, field },
    message: `${field} ${constraint}. Correct it and retry.`,
    operation: "tools/call",
    requestId,
    retryable: false,
  });

const decode = <A, Input>(
  schema: Schema.Decoder<A>,
  value: Input,
  requestId: RequestId,
  field: string
) =>
  Effect.catchTag(
    Schema.decodeUnknownEffect(schema)(value),
    "SchemaError",
    () =>
      Effect.fail(invalid(requestId, field, "does not match the tool schema"))
  );

const noMentions: readonly string[] = [];
const noMembers: readonly AgentId[] = [];

interface ToolCtx {
  readonly actor: Actor;
  readonly args: Schema.Schema.Type<typeof Args>;
  readonly chat: IChat;
  readonly requestId: RequestId;
}

const present = <A>(
  value: Json | undefined,
  schema: Schema.Decoder<A>,
  requestId: RequestId,
  name: string,
  fallback: A
) =>
  value === undefined
    ? Effect.succeed(fallback)
    : decode(schema, value, requestId, name);

const roomOf = (ctx: ToolCtx) =>
  decode(RoomId, ctx.args.room, ctx.requestId, "room");

const limitOf = (ctx: ToolCtx, fallback: number) =>
  present(ctx.args.limit, Schema.Number, ctx.requestId, "limit", fallback);

const sinceOf = (ctx: ToolCtx) =>
  present(ctx.args.since, Schema.Number, ctx.requestId, "since", 0);

const threadOf = (ctx: ToolCtx, key: "thread" | "thread_root" | "reply_to") =>
  present(
    at(ctx.args, key),
    Schema.NullOr(Schema.Number),
    ctx.requestId,
    key,
    null
  );

const mentionsOf = (ctx: ToolCtx) =>
  present(
    ctx.args.mentions,
    Schema.Array(Schema.String),
    ctx.requestId,
    "mentions",
    noMentions
  );

const createRoom = (ctx: ToolCtx) =>
  Effect.gen(function* () {
    const roomName = yield* decode(
      Schema.String,
      ctx.args.name,
      ctx.requestId,
      "name"
    );
    const topic = yield* present(
      ctx.args.topic,
      Schema.String,
      ctx.requestId,
      "topic",
      ""
    );
    const members = yield* present(
      ctx.args.members,
      Schema.Array(AgentId),
      ctx.requestId,
      "members",
      noMembers
    );
    return yield* asTool(
      ctx.chat.createRoom({
        actor: ctx.actor,
        memberIds: members,
        name: roomName,
        requestId: ctx.requestId,
        topic,
      })
    );
  });

const postMessage = (ctx: ToolCtx) =>
  Effect.gen(function* () {
    return yield* asTool(
      ctx.chat.postMessage({
        actor: ctx.actor,
        body: yield* decode(
          Schema.String,
          ctx.args.body,
          ctx.requestId,
          "body"
        ),
        mentions: yield* mentionsOf(ctx),
        replyTo: yield* threadOf(ctx, "reply_to"),
        requestId: ctx.requestId,
        roomId: yield* roomOf(ctx),
        threadRoot: yield* threadOf(ctx, "thread_root"),
      })
    );
  });

const pageOf = (ctx: ToolCtx) =>
  Effect.gen(function* () {
    return {
      actor: ctx.actor,
      limit: yield* limitOf(ctx, 50),
      requestId: ctx.requestId,
      roomId: yield* roomOf(ctx),
      since: yield* sinceOf(ctx),
      thread: yield* threadOf(ctx, "thread"),
    };
  });

const readMessages = (ctx: ToolCtx) =>
  Effect.gen(function* () {
    return yield* asTool(ctx.chat.readMessages(yield* pageOf(ctx)));
  });

const readTranscript = (ctx: ToolCtx) =>
  Effect.gen(function* () {
    const format = yield* present(
      ctx.args.format,
      Schema.Literals(["markdown", "json"]),
      ctx.requestId,
      "format",
      "markdown"
    );
    return yield* asTool(
      ctx.chat.readTranscript({ ...(yield* pageOf(ctx)), format })
    );
  });

const waitForMessages = (ctx: ToolCtx) =>
  Effect.gen(function* () {
    const timeoutMs = yield* present(
      ctx.args.timeout_ms,
      Schema.Number,
      ctx.requestId,
      "timeout_ms",
      25_000
    );
    return yield* asTool(
      ctx.chat.waitForMessages(
        ctx.actor,
        ctx.requestId,
        yield* roomOf(ctx),
        yield* sinceOf(ctx),
        yield* limitOf(ctx, 50),
        timeoutMs
      )
    );
  });

const handlers: {
  readonly [name: string]: (ctx: ToolCtx) => Effect.Effect<ToolBody, ChatError>;
} = {
  create_room: createRoom,
  edit_message: (ctx) =>
    Effect.gen(function* () {
      return yield* asTool(
        ctx.chat.editMessage(
          ctx.actor,
          ctx.requestId,
          yield* roomOf(ctx),
          yield* decode(Schema.Number, ctx.args.seq, ctx.requestId, "seq"),
          yield* decode(Schema.String, ctx.args.body, ctx.requestId, "body"),
          yield* mentionsOf(ctx)
        )
      );
    }),
  get_unread: (ctx) =>
    Effect.gen(function* () {
      return yield* asTool(
        ctx.chat.getUnread(ctx.actor, ctx.requestId, yield* roomOf(ctx))
      );
    }),
  invite: (ctx) =>
    Effect.gen(function* () {
      return yield* asTool(
        ctx.chat.invite(
          ctx.actor,
          ctx.requestId,
          yield* roomOf(ctx),
          yield* decode(AgentId, ctx.args.agent_id, ctx.requestId, "agent_id")
        )
      );
    }),
  join: (ctx) =>
    Effect.gen(function* () {
      return yield* asTool(
        ctx.chat.join(ctx.actor, ctx.requestId, yield* roomOf(ctx))
      );
    }),
  leave: (ctx) =>
    Effect.gen(function* () {
      return yield* asTool(
        ctx.chat.leave(ctx.actor, ctx.requestId, yield* roomOf(ctx))
      );
    }),
  list_rooms: (ctx) => asTool(ctx.chat.listRooms(ctx.actor, ctx.requestId)),
  list_threads: (ctx) =>
    Effect.gen(function* () {
      return yield* asTool(
        ctx.chat.listThreads(
          ctx.actor,
          ctx.requestId,
          yield* roomOf(ctx),
          yield* limitOf(ctx, 50)
        )
      );
    }),
  mark_read: (ctx) =>
    Effect.gen(function* () {
      return yield* asTool(
        ctx.chat.markRead(
          ctx.actor,
          ctx.requestId,
          yield* roomOf(ctx),
          yield* decode(Schema.Number, ctx.args.seq, ctx.requestId, "seq")
        )
      );
    }),
  members: (ctx) =>
    Effect.gen(function* () {
      return yield* asTool(
        ctx.chat.members(ctx.actor, ctx.requestId, yield* roomOf(ctx))
      );
    }),
  post_message: postMessage,
  react: (ctx) =>
    Effect.gen(function* () {
      return yield* asTool(
        ctx.chat.react(
          ctx.actor,
          ctx.requestId,
          yield* roomOf(ctx),
          yield* decode(Schema.Number, ctx.args.seq, ctx.requestId, "seq"),
          yield* decode(Schema.String, ctx.args.emoji, ctx.requestId, "emoji")
        )
      );
    }),
  read_messages: readMessages,
  read_transcript: readTranscript,
  redact_message: (ctx) =>
    Effect.gen(function* () {
      return yield* asTool(
        ctx.chat.redactMessage(
          ctx.actor,
          ctx.requestId,
          yield* roomOf(ctx),
          yield* decode(Schema.Number, ctx.args.seq, ctx.requestId, "seq")
        )
      );
    }),
  register_webhook: (ctx) =>
    Effect.gen(function* () {
      return yield* asTool(
        ctx.chat.registerWebhook(
          ctx.actor,
          ctx.requestId,
          yield* decode(
            Schema.NullOr(Schema.String),
            ctx.args.webhook_url,
            ctx.requestId,
            "webhook_url"
          )
        )
      );
    }),
  search_messages: (ctx) =>
    Effect.gen(function* () {
      return yield* asTool(
        ctx.chat.searchMessages(
          ctx.actor,
          ctx.requestId,
          yield* roomOf(ctx),
          yield* decode(Schema.String, ctx.args.query, ctx.requestId, "query"),
          yield* limitOf(ctx, 50)
        )
      );
    }),
  wait_for_messages: waitForMessages,
  whoami: (ctx) => toolOk(ctx.chat.whoami(ctx.actor)),
};

export const callTool = (
  actor: Actor,
  name: string,
  rawArgs: object,
  requestId: RequestId
) =>
  Effect.gen(function* () {
    const chat = yield* Chat;
    const args = yield* decode(Args, rawArgs, requestId, "arguments");
    const handler = at(handlers, name);
    if (handler === undefined) {
      return yield* asTool(
        Effect.fail(
          invalid(requestId, "name", "is not a tool this server provides")
        )
      );
    }
    return yield* handler({ actor, args, chat, requestId });
  });
