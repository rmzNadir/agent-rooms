// Alchemy previews adoption only when every Worker prop resolves
// (`isResolved` in Plan.ts). Effect-native Durable Object exports keep a
// constructor Effect (`DurableObjectExport` in DurableObject.ts). That
// Effect fails the check, the cloud read never runs, and the plan says
// create. Replacing that constructor with a class instance stops the walk.
// The object stays plain data, so the local bundle still sees `kind`
// after `stripEffects` (`LocalProvider.ts`) and still emits the class.
//
// `services` is an Effect `Context`. In Effect 4 that object is plain data
// and `cacheRoot` points at the object itself. Plan's walkers cut that
// cycle (`mapPlainData` in `Util/data.ts`). `encodeState` does not, and the
// adopt apply persists the unstripped `old` props (`Apply.ts`). The cycle
// overflows the stack. The stored export keeps `kind` and drops `services`.

import { Effect } from "effect";

class SealedConstructor {}

const sealEntry = (entry: object) => {
  const constructorProperty = Object.getOwnPropertyDescriptor(
    entry,
    "constructor"
  );
  const services = Object.getOwnPropertyDescriptor(entry, "services");
  const replaceConstructor =
    constructorProperty !== undefined &&
    Effect.isEffect(constructorProperty.value);
  const replaceServices =
    services !== undefined &&
    typeof services.value === "object" &&
    services.value !== null;
  if (!(replaceConstructor || replaceServices)) {
    return entry;
  }
  return {
    ...entry,
    ...(replaceConstructor ? { constructor: new SealedConstructor() } : {}),
    ...(replaceServices ? { services: {} } : {}),
  };
};

export const sealWorkerExports = <Exports extends object>(
  exports: Exports
): Exports =>
  Object.fromEntries(
    Object.entries(exports).map(([name, entry]) => [
      name,
      typeof entry === "object" && entry !== null ? sealEntry(entry) : entry,
    ])
  ) as Exports;

export const sealResourceExports = <
  Props extends { exports?: object | undefined },
>(resource: {
  Props: Props;
}): void => {
  const current = resource.Props.exports;
  if (current === undefined) {
    return;
  }
  resource.Props = {
    ...resource.Props,
    exports: sealWorkerExports(current),
  };
};
