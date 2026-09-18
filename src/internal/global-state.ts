/**
 * State kept under a name on `globalThis`, or privately when there is no name.
 *
 * What a `storageKey` option does: a module evaluated more than once — Next
 * compiles the proxy, route handlers and pages as separate module graphs — builds
 * its class again each time, and state closed over by the class is then one per
 * copy. Under a `storageKey`, every copy finds the same state. Without one,
 * nothing is shared, and anchoring the class (`@ecosy/anchor`) still works.
 *
 * @internal Not exported from any entry.
 */
export function globalState<State>(namespace: string, storageKey: string | undefined, create: () => State): State {
  if (storageKey === undefined) return create();

  if (typeof storageKey !== "string" || storageKey.length === 0) {
    throw new TypeError(`[ecosy/sapedb:${namespace}] storageKey must be a non-empty string`);
  }

  const key = Symbol.for(`@ecosy/sapedb/${namespace}:${storageKey}`);
  const holder = globalThis as unknown as Record<symbol, State | undefined>;

  if (!holder[key]) {
    Object.defineProperty(holder, key, { value: create(), writable: false, configurable: false, enumerable: false });
  }

  return holder[key]!;
}
