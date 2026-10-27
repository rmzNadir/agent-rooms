import { describe, expect, test } from "bun:test";
import { isDurableObjectExport } from "alchemy/Cloudflare/Workers/DurableObject";
import { isResolved, stripEffects } from "alchemy/Diff";
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
