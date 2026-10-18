import type { Effect, Layer, Schema } from "effect";

export interface AggregateClient {
  readonly schedule: (
    id: string,
    command: object,
    options: { readonly after: number }
  ) => Effect<void, never, never>;
  readonly send: (id: string, command: object) => Effect<void, never, never>;
}

export interface WebhookClient {
  readonly deliver: (args: {
    readonly body: string;
    readonly roomId: string;
  }) => Effect<void, never, never>;
}

export interface StreamClient {
  readonly append: (
    origin: object,
    event: object
  ) => Effect<void, never, never>;
}

interface Constructor<T> {
  new (props?: T): T & { readonly _tag: string };
}

export declare function Event<F extends Schema.Struct.Fields = {}>(
  tag: string,
  fields?: F
): Constructor<Schema.Struct<F>["Type"]>;

export declare function Command<F extends Schema.Struct.Fields = {}>(
  tag: string,
  options: {
    readonly events: readonly object[];
    readonly input?: F;
    readonly rejects: readonly object[];
    readonly reply?: Schema.Struct.Fields;
    readonly target: Schema.Top;
  }
): Constructor<Schema.Struct<F>["Type"]>;

export declare function Rejection<F extends Schema.Struct.Fields = {}>(
  tag: string,
  fields?: F
): Constructor<Schema.Struct<F>["Type"]>;

export interface AggregateClass extends Effect<AggregateClient, never, never> {
  ref(id: string): { readonly id: string };
  new (...args: readonly object[]): object;
}

export declare function Aggregate(
  name: string,
  definition: object
): AggregateClass;

export interface ViewClass {
  new (...args: readonly object[]): object;
}

export declare function View(name: string, definition: object): ViewClass;

export interface PolicyClass {
  toLayer(build: object, options?: object): Layer.Layer<never>;
  new (...args: readonly object[]): object;
}

export declare function Policy(name: string, definition: object): PolicyClass;

export interface ProjectionClass {
  toLayer(build: object, options?: object): Layer.Layer<never>;
  new (...args: readonly object[]): object;
}

export declare function Projection(
  name: string,
  definition: object
): ProjectionClass;

export interface StreamClass extends Effect<StreamClient, never, never> {
  new (...args: readonly object[]): object;
}

export declare function Stream(name: string, definition: object): StreamClass;

export interface ExternalClass extends Effect<WebhookClient, never, never> {
  readonly deliver: object;
  toLayer(build: object): Layer.Layer<never>;
  new (...args: readonly object[]): object;
}

export declare function ExternalSystem(
  name: string,
  ops: object
): ExternalClass;

export interface ModelClass {
  layer(handlers: object): Layer.Layer<never>;
  new (...args: readonly object[]): object;
}

export declare function Model(name: string, members: object): ModelClass;

export declare const InMemory: Layer.Layer<never>;
