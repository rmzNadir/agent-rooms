// Alchemy previews adoption only when every Worker prop resolves
// (`isResolved` in Plan.ts). Effect-native Durable Object exports keep a
// constructor Effect (`DurableObjectExport` in DurableObject.ts). That
// Effect fails the check, the cloud read never runs, and the plan says
// create. Replacing that constructor with a class instance stops the walk.
// The object stays plain data, so the local bundle still sees `kind`
// after `stripEffects` (`LocalProvider.ts`) and still emits the class.

import { Effect } from "effect";

class SealedConstructor {}

const sealEntry = (entry: object) => {
  const descriptor = Object.getOwnPropertyDescriptor(entry, "constructor");
  if (descriptor === undefined || !Effect.isEffect(descriptor.value)) {
    return entry;
  }
  return {
    ...entry,
    constructor: new SealedConstructor(),
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
