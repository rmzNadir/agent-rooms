import { DurableObjectState } from "alchemy/Cloudflare";
import { Effect } from "effect";
import { sqlRow } from "./sql-row.ts";

export const execRows = <Failure>(
  sql: string,
  bindings: ReadonlyArray<string | number | null>,
  failure: Failure
) =>
  Effect.gen(function* () {
    const current = yield* DurableObjectState;
    const cursor = yield* current.storage.sql.exec<
      Record<string, string | number | null>
    >(sql, ...bindings);
    const rows = yield* cursor.toArray();
    return rows.map(sqlRow);
  }).pipe(Effect.catchDefect(() => Effect.fail(failure)));
