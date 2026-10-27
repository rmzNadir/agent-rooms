import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layer as nodeFileSystem } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePath } from "@effect/platform-node/NodePath";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { isDurableObjectExport } from "alchemy/Cloudflare/Workers/DurableObject";
import { isResolved, stripEffects } from "alchemy/Diff";
import { makeLocalState } from "alchemy/State/LocalState";
import type { UpdatingReourceState } from "alchemy/State/ResourceState";
import { encodeState } from "alchemy/State/StateEncoding";
import { isPlainData } from "alchemy/Util/data";
import { Effect, Layer } from "effect";
import {
  sealResourceExports,
  sealWorkerExports,
} from "../src/runtime/seal-exports.ts";

const durableObjectConstructor = Effect.void;

const exportsWithEffect = () => ({
  RoomAggregate: {
    constructor: durableObjectConstructor,
    kind: "durableObject",
  },
});

const kept = () => "kept";

describe("sealed worker exports", () => {
  test("keeps class names and resolves for the adoption probe", () => {
    const plain = exportsWithEffect();
    const sealed = sealWorkerExports(plain);
    expect(isPlainData(sealed)).toBe(true);
    expect(isPlainData(plain)).toBe(true);
    expect(isResolved({ exports: plain, name: "agentrooms-api" })).toBe(false);
    expect(isResolved({ exports: sealed, name: "agentrooms-api" })).toBe(true);
    expect(Object.keys(sealed)).toEqual(["RoomAggregate"]);
    expect(sealed.RoomAggregate.kind).toBe("durableObject");
    expect(Effect.isEffect(sealed.RoomAggregate.constructor)).toBe(false);
    expect(isDurableObjectExport(stripEffects(sealed).RoomAggregate)).toBe(
      true
    );
    expect(sealWorkerExports({ label: "kept" }).label).toBe("kept");
    expect(sealWorkerExports({ slot: null }).slot).toBeNull();
    expect(sealWorkerExports({ kept }).kept).toBe(kept);
    const marker = { text: "kept" };
    expect(sealWorkerExports({ marker }).marker).toBe(marker);
    expect(
      sealWorkerExports({
        RoomAggregate: { constructor: "plain", kind: "durableObject" },
      }).RoomAggregate.constructor
    ).toBe("plain");
  });

  test("leaves a worker with no exports unchanged", () => {
    const resource: { Props: { name: string; exports?: object } } = {
      Props: { name: "agentrooms-api" },
    };
    sealResourceExports(resource);
    expect(resource.Props).toEqual({ name: "agentrooms-api" });
  });

  test("stores a sealed adopt row in a local stage", async () => {
    const services = Effect.runSync(Effect.context());
    const raw = {
      RoomAggregate: {
        constructor: durableObjectConstructor,
        kind: "durableObject" as const,
        services,
      },
    };
    expect(() => encodeState({ old: { props: { exports: raw } } })).toThrow(
      RangeError
    );
    const sealed = sealWorkerExports(raw);
    const readServices = (entry: object) =>
      Object.getOwnPropertyDescriptor(entry, "services")?.value;
    expect(readServices(sealed.RoomAggregate)).toEqual({});
    expect(
      readServices(
        sealWorkerExports({
          RoomAggregate: { kind: "durableObject", services },
        }).RoomAggregate
      )
    ).toEqual({});
    expect(
      readServices(
        sealWorkerExports({
          RoomAggregate: {
            constructor: "plain",
            kind: "durableObject",
            services: null,
          },
        }).RoomAggregate
      )
    ).toBeNull();
    expect(
      readServices(
        sealWorkerExports({
          RoomAggregate: {
            constructor: "plain",
            kind: "durableObject",
            services: "kept",
          },
        }).RoomAggregate
      )
    ).toBe("kept");
    expect(sealed.RoomAggregate.kind).toBe("durableObject");
    expect(isDurableObjectExport(sealed.RoomAggregate)).toBe(true);
    const created = {
      attr: { workerName: "agentrooms-api-nadir-ge6trjlkbqiolu4t" },
      bindings: [],
      downstream: [],
      fqn: "Api",
      instanceId: "proof",
      logicalId: "Api",
      namespace: undefined,
      props: { exports: sealed },
      providerVersion: 0,
      resourceType: "Cloudflare.Worker",
      status: "created" as const,
    };
    const updating: UpdatingReourceState = {
      ...created,
      adopting: true,
      old: created,
      status: "updating",
    };
    const dir = mkdtempSync(join(tmpdir(), "agent-rooms-state-"));
    try {
      const stored = await Effect.runPromise(
        Effect.gen(function* () {
          const state = yield* makeLocalState();
          yield* state.set({
            fqn: "Api",
            stack: "AgentRooms",
            stage: "encode-proof",
            value: updating,
          });
          return yield* state.get({
            fqn: "Api",
            stack: "AgentRooms",
            stage: "encode-proof",
          });
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              nodeFileSystem,
              nodePath,
              Layer.succeed(AlchemyContext, {
                adopt: false,
                dev: false,
                dotAlchemy: dir,
              })
            )
          )
        )
      );
      expect(stored?.status).toBe("updating");
      expect(JSON.stringify(stored)).not.toContain("cacheRoot");
      expect(JSON.stringify(stored)).toContain("durableObject");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("seals the exports the plan reads", () => {
    const resource = {
      Props: { exports: exportsWithEffect(), name: "agentrooms-api" },
    };
    expect(isResolved(resource.Props)).toBe(false);
    sealResourceExports(resource);
    expect(isResolved(resource.Props)).toBe(true);
    expect(resource.Props.name).toBe("agentrooms-api");
    expect(resource.Props.exports.RoomAggregate.kind).toBe("durableObject");
    expect(
      Effect.isEffect(resource.Props.exports.RoomAggregate.constructor)
    ).toBe(false);
  });
});
