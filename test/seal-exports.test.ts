import { describe, expect, test } from "bun:test";
import { isResolved } from "alchemy/Diff";
import { isPlainData } from "alchemy/Util/data";
import { Effect } from "effect";
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

describe("sealed worker exports", () => {
  test("keeps constructors readable and resolves for the adoption probe", () => {
    const plain = exportsWithEffect();
    const sealed = sealWorkerExports(plain);
    expect(isPlainData(sealed)).toBe(false);
    expect(isResolved({ exports: plain, name: "agentrooms-api" })).toBe(false);
    expect(isResolved({ exports: sealed, name: "agentrooms-api" })).toBe(true);
    expect(Object.keys(sealed)).toEqual(["RoomAggregate"]);
    expect(sealed.RoomAggregate.kind).toBe("durableObject");
    expect(sealed.RoomAggregate.constructor).toBe(durableObjectConstructor);
    expect(Object.entries(sealed)[0]?.[1].constructor).toBe(
      durableObjectConstructor
    );
  });

  test("leaves a worker with no exports unchanged", () => {
    const resource: { Props: { name: string; exports?: object } } = {
      Props: { name: "agentrooms-api" },
    };
    sealResourceExports(resource);
    expect(resource.Props).toEqual({ name: "agentrooms-api" });
  });

  test("seals the exports the plan reads", () => {
    const resource = {
      Props: { exports: exportsWithEffect(), name: "agentrooms-api" },
    };
    expect(isResolved(resource.Props)).toBe(false);
    sealResourceExports(resource);
    expect(isResolved(resource.Props)).toBe(true);
    expect(resource.Props.name).toBe("agentrooms-api");
    expect(resource.Props.exports.RoomAggregate.constructor).toBe(
      durableObjectConstructor
    );
  });
});
