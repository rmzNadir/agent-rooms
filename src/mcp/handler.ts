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
import { makeRequestId } from "../domain/ids.ts";
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
  const { value } = await read();
  if (value === undefined) {
    return { chunks, total };
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
    return blankBody();
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

export const blankBody = () => String.fromCharCode();

export const mediaType = (header: string) =>
  (header.split(";")[0] as string).trim();

export const eventStream = (header: string | null) =>
  header !== null && mediaType(header) === "text/event-stream";

export const singleSseData = (body: string): string | undefined => {
  const data = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line.length > 0);
  if (data.length !== 1) {
    return undefined;
  }
  const payload = data[0] as string;
  try {
    JSON.parse(payload);
  } catch {
    return undefined;
  }
  return payload;
};

const responseInit = (status: number, headers: Headers) => ({
  headers,
  status,
});

export const finishSse = (
  text: string,
  status: number,
  headers: Headers
): Response => {
  const payload = singleSseData(text);
  if (payload === undefined) {
    return new Response(text, responseInit(status, headers));
  }
  return jsonResponse(payload, status);
};

export const toolArgs = (
  args: object | string | number | boolean | null | undefined
): object => {
  if (args !== null && typeof args === "object") {
    return args;
  }
  return { arguments: "rejected" };
};

export const handlerInit = (agentId: string) => ({
  authInfo: mcpAuth(agentId),
});

export const tooLargeBody = () =>
  JSON.stringify({
    error: { code: -32_013, message: "Payload Too Large" },
    id: null,
    jsonrpc: "2.0",
  });

export const jsonHeaders = () => ({ "content-type": "application/json" });

const jsonResponse = (body: string, status: number) =>
  new Response(body, {
    headers: jsonHeaders(),
    status,
  });

export const acceptHeader = (value: string | null) => value ?? "";

export const responseType = (header: string | null) =>
  header === null ? "application/json" : header;

export const mcpAuth = (agentId: string) => ({
  clientId: agentId,
  extra: { agentId },
  scopes: [] as string[],
  token: "bearer",
});

export const mcpHandlerOptions = () => ({ legacy: "stateless" as const });

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
        const raw = toolArgs(
          args as object | string | number | boolean | null | undefined
        );
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
      const requestId = yield* Effect.orDie(makeRequestId());
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
  const accept = acceptHeader(web.headers.get("accept"));
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
  if (bodyText === undefined) {
    return jsonResponse(tooLargeBody(), 413);
  }
  const rejection = versionRejection(
    bodyText,
    forwarded.headers.get("mcp-protocol-version")
  );
  if (rejection !== undefined) {
    return jsonResponse(
      JSON.stringify(unsupportedProtocolVersionBody(rejection)),
      400
    );
  }
  const handler = createMcpHandler(
    () => serverFor(actor, services),
    mcpHandlerOptions()
  );
  const response = await handler.fetch(forwarded, handlerInit(actor.agentId));
  if (wantsStream || !eventStream(response.headers.get("content-type"))) {
    return response;
  }
  const text = await response.text();
  return finishSse(text, response.status, response.headers);
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
      contentType: responseType(response.headers.get("content-type")),
      status: response.status,
    });
  });
