import {
  createMcpHandler,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  fromJsonSchema,
  type JsonSchemaType,
  type jsonSchemaValidator,
  McpServer,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { type Context, Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Chat } from "../app/chat.ts";
import type { Actor } from "../domain/actor.ts";
import { internalRequestId, makeRequestId } from "../domain/ids.ts";
import { callTool, toolErr } from "./call-tool.ts";
import { agentInstructions } from "./guide.ts";
import {
  supportedProtocolVersions,
  unsupportedProtocolVersionBody,
  versionRejection,
} from "./protocol.ts";
import { tools } from "./tool-list.ts";

const streamAccept = "application/json, text/event-stream";

type BodyReader = ReturnType<ReadableStream<Uint8Array>["getReader"]>;

const takeChunks = async (
  reader: BodyReader,
  max: number,
  chunks: Uint8Array[],
  total: number
): Promise<
  { readonly chunks: Uint8Array[]; readonly total: number } | undefined
> => {
  const read = reader.read.bind(reader) as () => Promise<{
    done: boolean;
    value?: ArrayBufferView;
  }>;
  const { done, value } = await read();
  if (done) {
    return { chunks, total };
  }
  if (value === undefined) {
    return takeChunks(reader, max, chunks, total);
  }
  const next = total + value.byteLength;
  if (next > max) {
    await reader.cancel();
    return undefined;
  }
  chunks.push(
    new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    )
  );
  return takeChunks(reader, max, chunks, next);
};

const effectValidatesArguments = {
  getValidator: () => (input) => ({
    data: input,
    errorMessage: undefined,
    valid: true,
  }),
} as jsonSchemaValidator;

const readCapped = async (
  request: {
    readonly headers: { get: (name: string) => string | null };
    readonly body: ReadableStream<Uint8Array> | null;
  },
  max: number
): Promise<string | undefined> => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    return undefined;
  }
  const { body } = request;
  if (body === null) {
    return "";
  }
  const reader = body.getReader();
  const taken = await takeChunks(reader, max, [], 0);
  if (taken === undefined) {
    return undefined;
  }
  const { chunks, total } = taken;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const singleSseData = (body: string): string | undefined => {
  const data = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line.length > 0);
  const [payload] = data;
  if (data.length !== 1 || payload === undefined) {
    return undefined;
  }
  try {
    JSON.parse(payload);
  } catch {
    return undefined;
  }
  return payload;
};

const jsonResponse = (body: string, status: number) =>
  new Response(body, {
    headers: { "content-type": "application/json" },
    status,
  });

const serverFor = (actor: Actor, services: Context.Context<Chat>) => {
  const server = new McpServer(
    { name: "agent-rooms", version: "0.1.0" },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: agentInstructions,
      supportedProtocolVersions: [...supportedProtocolVersions],
    }
  );
  for (const tool of tools) {
    const inputSchema = fromJsonSchema(
      tool.inputSchema as JsonSchemaType,
      effectValidatesArguments
    );
    server.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON>(
      tool.name,
      { description: tool.description, inputSchema },
      async (args) => {
        const raw = args !== null && typeof args === "object" ? args : {};
        const body = await yieldTool(services, actor, tool.name, raw);
        return {
          content: body.content.map((block) => ({
            text: block.text,
            type: block.type,
          })),
          isError: body.isError,
        };
      }
    );
  }
  return server;
};

const yieldTool = (
  services: Context.Context<Chat>,
  actor: Actor,
  name: string,
  raw: object
) =>
  Effect.runPromiseWith(services)(
    Effect.gen(function* () {
      const requestId = yield* Effect.catchTag(
        makeRequestId(),
        "SchemaError",
        () => Effect.succeed(internalRequestId)
      );
      return yield* Effect.catchTag(
        callTool(actor, name, raw, requestId),
        "InvalidArgument",
        toolErr
      );
    })
  );

export const serveMcp = async (
  web: Request,
  actor: Actor,
  services: Context.Context<Chat>
): Promise<Response> => {
  const accept = web.headers.get("accept") ?? "";
  const wantsStream = accept.includes("text/event-stream");
  const headers = new Headers(web.headers);
  if (!wantsStream) {
    headers.set("accept", streamAccept);
  }
  const forwarded = new Request(web, { headers });
  const bodyText = await readCapped(
    forwarded.clone(),
    DEFAULT_MAX_REQUEST_BODY_SIZE
  );
  const rejection =
    bodyText === undefined
      ? undefined
      : versionRejection(
          bodyText,
          forwarded.headers.get("mcp-protocol-version")
        );
  if (rejection !== undefined) {
    return jsonResponse(
      JSON.stringify(unsupportedProtocolVersionBody(rejection)),
      400
    );
  }
  const handler = createMcpHandler(() => serverFor(actor, services), {
    legacy: "stateless",
  });
  const response = await handler.fetch(forwarded, {
    authInfo: {
      clientId: actor.agentId,
      extra: { agentId: actor.agentId },
      scopes: [],
      token: "bearer",
    },
  });
  if (
    wantsStream ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    return response;
  }
  const text = await response.text();
  const payload = singleSseData(text);
  if (payload === undefined) {
    return new Response(text, {
      headers: response.headers,
      status: response.status,
    });
  }
  return jsonResponse(payload, response.status);
};

export const handleMcp = (actor: Actor) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const services = yield* Effect.context<Chat>();
    const { source } = request;
    if (!(source instanceof Request)) {
      return yield* Effect.die("The worker request has no web Request.");
    }
    const response = yield* Effect.promise(() =>
      serveMcp(source, actor, services)
    );
    const bytes = new Uint8Array(
      yield* Effect.promise(() => response.arrayBuffer())
    );
    return HttpServerResponse.uint8Array(bytes, {
      contentType: response.headers.get("content-type") ?? "application/json",
      status: response.status,
    });
  });
