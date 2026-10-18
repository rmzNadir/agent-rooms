import type { Effect } from "effect";

export const client = <A>(value: object): Effect.Effect<A> => value as never;
