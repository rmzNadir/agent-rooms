// Alchemy previews adoption only when every Worker prop resolves
// (`isResolved` in Plan.ts). Effect-native Durable Object exports keep a
// constructor Effect (`DurableObjectExport` in DurableObject.ts). That
// Effect fails the check, the cloud read never runs, and the plan says
// create. A proxy with its own prototype is one resolved leaf to that
// walk. Property reads still reach the constructors the bundle uses.

class SealedExports {}

export const sealWorkerExports = <Exports extends object>(
  exports: Exports
): Exports =>
  new Proxy(exports, {
    getPrototypeOf: () => SealedExports.prototype,
  });

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
