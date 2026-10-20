import { type Context, Effect, Layer, Scope } from "effect";

export const fulfill = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect as Effect.Effect<A, never, never>);

export const buildIn = <A, E, R>(
  layer: Layer.Layer<A, E, R>,
  scope: Scope.Scope
) =>
  fulfill(Layer.build(layer).pipe(Effect.provideService(Scope.Scope, scope)));

export const buildProvided = <A, E, R, Services>(
  layer: Layer.Layer<A, E, R>,
  context: Context.Context<Services>,
  scope: Scope.Scope
) =>
  fulfill(
    Layer.build(layer).pipe(
      Effect.provide(Layer.succeedContext(context)),
      Effect.provideService(Scope.Scope, scope)
    )
  );

export const runIn = <A, E, R, Services>(
  effect: Effect.Effect<A, E, R>,
  context: Context.Context<Services>,
  scope: Scope.Scope
) =>
  fulfill(
    effect.pipe(
      Effect.provide(Layer.succeedContext(context)),
      Effect.provideService(Scope.Scope, scope)
    ) as Effect.Effect<A, never, never>
  );

export const provideLayer = <A, E, R, B, E2, R2>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<B, E2, R2>
) =>
  fulfill(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>);
