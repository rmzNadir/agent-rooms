import { Effect, Schema } from "effect";
import type { HttpClientError } from "effect/http/HttpClientError";
import { InvalidArgument, Unavailable } from "../domain/errors.ts";
import type { RequestId } from "../domain/ids.ts";

const callDown = (requestId: RequestId, operation: string, message: string) =>
  new Unavailable({
    code: "Unavailable",
    details: {},
    message,
    operation,
    requestId,
    retryable: true,
  });

const callSettle = <A, E>(
  effect: Effect.Effect<A, E | HttpClientError | Schema.SchemaError>,
  requestId: RequestId,
  operation: string,
  message: string
) => {
  const fail = () => Effect.fail(callDown(requestId, operation, message));
  return effect.pipe(
    Effect.catchTag("HttpClientError", fail),
    Effect.catchTag("SchemaError", fail)
  );
};

const directoryDown = "The directory did not respond. Retry the same request.";
const roomDownMessage = "The room did not respond. Retry the same request.";
const directoryPayload =
  "The request did not match the directory API. Check the fields and retry.";
const roomPayload =
  "The request did not match the room API. Check the fields and retry.";

export const directorySettle = <A, E>(
  effect: Effect.Effect<A, E | HttpClientError | Schema.SchemaError>,
  requestId: RequestId,
  operation: string
) => callSettle(effect, requestId, operation, directoryDown);

export const roomSettle = <A, E>(
  effect: Effect.Effect<A, E | HttpClientError | Schema.SchemaError>,
  requestId: RequestId,
  operation: string
) => callSettle(effect, requestId, operation, roomDownMessage);

export const roomDown = (requestId: RequestId, operation: string) =>
  callDown(requestId, operation, roomDownMessage);

export const directoryPrepare = <A>(
  schema: Schema.Decoder<A>,
  payload: { readonly requestId: RequestId },
  operation: string
) => callPrepare(schema, payload, operation, directoryPayload);

export const roomPrepare = <A>(
  schema: Schema.Decoder<A>,
  payload: { readonly requestId: RequestId },
  operation: string
) => callPrepare(schema, payload, operation, roomPayload);

const callPrepare = <A>(
  schema: Schema.Decoder<A>,
  payload: { readonly requestId: RequestId },
  operation: string,
  message: string
) =>
  Effect.catchTag(
    Schema.decodeUnknownEffect(schema)(payload),
    "SchemaError",
    () =>
      Effect.fail(
        new InvalidArgument({
          code: "InvalidArgument",
          details: { constraint: "schema", field: "payload" },
          message,
          operation,
          requestId: payload.requestId,
          retryable: false,
        })
      )
  );
