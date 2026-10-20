import { Database } from "bun:sqlite";
import { DurableObjectState } from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Effect, Layer } from "effect";

// The durable object service type includes workerd-only fields. A direct assertion does not overlap, so this one bridge adapts the sqlite storage the room and directory actually call.
export const asService = <Service>(value: object): Service => value as Service;

type Cell = string | number | null;
type SqlRecord = Record<string, string | number | bigint | null | boolean>;

const normalize = (row: SqlRecord) => {
  const record: Record<string, Cell> = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (typeof value === "string" || typeof value === "number") {
      record[key] = value;
    } else if (typeof value === "bigint") {
      record[key] = Number(value);
    } else if (typeof value === "boolean") {
      record[key] = value ? 1 : 0;
    } else if (value === null) {
      record[key] = null;
    }
  }
  return record;
};

const transact = <A, E, R>(db: Database, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      db.exec("BEGIN");
    });
    const exit = yield* Effect.exit(effect);
    if (exit._tag === "Success") {
      yield* Effect.sync(() => {
        db.exec("COMMIT");
      });
      return exit.value;
    }
    yield* Effect.sync(() => {
      db.exec("ROLLBACK");
    });
    return yield* Effect.failCause(exit.cause);
  });

// Workerd-only methods stay unimplemented. Room and directory code reaches storage through this sqlite database.
export const memoryLayer = (name: string) => {
  const db = new Database(":memory:");
  const readRows = (
    query: string,
    bindings: readonly (string | number | null)[]
  ) => {
    const statement = db.query<SqlRecord, (string | number | null)[]>(query);
    try {
      return statement.all(...bindings).map(normalize);
    } catch {
      statement.run(...bindings);
      return [];
    }
  };
  const sql = {
    databaseSize: 0,
    exec: (query: string, ...bindings: readonly (string | number | null)[]) =>
      Effect.sync(() => {
        const rows = readRows(query, bindings);
        return { toArray: () => Effect.succeed(rows) };
      }),
    raw: db,
  };
  const storage = {
    sql,
    transaction: (body: object) => {
      if (typeof body === "function") {
        const effect = body(sql);
        if (Effect.isEffect(effect)) {
          return transact(db, effect);
        }
        return Effect.die(
          "The storage transaction callback did not return an effect."
        );
      }
      if (Effect.isEffect(body)) {
        return transact(db, body);
      }
      return Effect.die("The storage transaction did not receive an effect.");
    },
  };
  const state = asService<Effect.Success<typeof DurableObjectState>>({
    acceptWebSocket: () => Effect.void,
    getWebSockets: () => Effect.succeed([]),
    id: { equals: () => false, name, toString: () => name },
    storage,
  });
  return Layer.succeed(DurableObjectState, state);
};

export const callbackRuntime = (
  remember: (
    handler: (payload: { readonly agentId: string }) => Effect.Effect<void>
  ) => void
) => {
  const context = {
    env: {},
    get: () => Effect.succeed(undefined),
    id: "sqlite",
    makeCallback: (
      _name: string,
      handler: (payload: { readonly agentId: string }) => Effect.Effect<void>
    ) =>
      Effect.sync(() => {
        remember(handler);
        return {
          cancel: () => Effect.void,
          schedule: () => Effect.void,
        };
      }),
    set: () => Effect.succeed("sqlite"),
    Type: "sqlite",
  };
  return Layer.succeed(RuntimeContext, asService(context));
};

export const openState = (
  name: string,
  runtime: Layer.Layer<RuntimeContext> = RuntimeContext.phantom
) => {
  const layer = memoryLayer(name);
  return <A, E>(
    effect: Effect.Effect<A, E, DurableObjectState | RuntimeContext>
  ) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(layer), Effect.provide(runtime))
    );
};
