import { Effect } from "effect";
import { InvalidArgument } from "../domain/errors.ts";
import type { RequestId } from "../domain/ids.ts";
import { webhookUrlProblem } from "../domain/webhook-url.ts";

const invalid = (
  requestId: RequestId,
  operation: string,
  field: string,
  constraint: string
) =>
  new InvalidArgument({
    code: "InvalidArgument",
    details: { constraint, field },
    message: `${field} ${constraint}. Correct it and retry.`,
    operation,
    requestId,
    retryable: false,
  });

export const bodyLimit = (
  requestId: RequestId,
  operation: string,
  body: string
) => {
  if (body.trim().length === 0 || body.length > 8000) {
    return Effect.fail(
      invalid(requestId, operation, "body", "must be 1 to 8000 characters")
    );
  }
  return Effect.void;
};

export const limitOf = (
  requestId: RequestId,
  operation: string,
  limit: number
) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return Effect.fail(
      invalid(requestId, operation, "limit", "must be an integer from 1 to 200")
    );
  }
  return Effect.succeed(limit);
};

export const sinceOf = (
  requestId: RequestId,
  operation: string,
  since: number
) => {
  if (!Number.isInteger(since) || since < 0) {
    return Effect.fail(
      invalid(requestId, operation, "since", "must be a non-negative integer")
    );
  }
  return Effect.succeed(since);
};

const emojiPattern = /^[\p{L}\p{N}\p{Extended_Pictographic}_+\-:]{1,16}$/u;

export const emojiOf = (requestId: RequestId, emoji: string) => {
  if (!emojiPattern.test(emoji)) {
    return Effect.fail(
      invalid(
        requestId,
        "react",
        "emoji",
        "must be 1 to 16 characters without spaces"
      )
    );
  }
  return Effect.succeed(emoji);
};

export const queryOf = (requestId: RequestId, query: string) => {
  if (query.trim().length === 0) {
    return Effect.fail(
      invalid(requestId, "search_messages", "query", "must not be empty")
    );
  }
  return Effect.succeed(query);
};

export const webhookOf = (
  requestId: RequestId,
  operation: string,
  webhookUrl: string | null
) => {
  if (webhookUrl === null) {
    return Effect.void;
  }
  const problem = webhookUrlProblem(webhookUrl);
  if (problem === undefined) {
    return Effect.void;
  }
  return Effect.fail(
    new InvalidArgument({
      code: "InvalidArgument",
      details: { constraint: problem, field: "webhookUrl" },
      message: `Webhook URL ${problem}. Use https, or http://127.0.0.1 for a local listener.`,
      operation,
      requestId,
      retryable: false,
    })
  );
};
