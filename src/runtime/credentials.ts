import { Context, Effect, Layer } from "effect";

export interface StoredCredential {
  readonly admin: boolean;
  readonly secret: string;
  readonly url: string | null;
}

export class CredentialBook extends Context.Service<
  CredentialBook,
  {
    readonly get: (
      agentId: string
    ) => Effect.Effect<StoredCredential | undefined>;
    readonly put: (
      agentId: string,
      credential: StoredCredential
    ) => Effect.Effect<void>;
  }
>()("@agent-rooms/CredentialBook") {}

export const memoryCredentials = () => {
  const rows = new Map<string, StoredCredential>();
  return Layer.succeed(
    CredentialBook,
    CredentialBook.of({
      get: (agentId) => Effect.sync(() => rows.get(agentId)),
      put: (agentId, credential) =>
        Effect.sync(() => {
          rows.set(agentId, credential);
        }),
    })
  );
};

export class LegacyImport extends Context.Service<
  LegacyImport,
  {
    readonly directory: () => Effect.Effect<void>;
    readonly room: (roomId: string) => Effect.Effect<void>;
  }
>()("@agent-rooms/LegacyImport") {}

export const legacySkip = Layer.succeed(
  LegacyImport,
  LegacyImport.of({
    directory: () => Effect.void,
    room: () => Effect.void,
  })
);
