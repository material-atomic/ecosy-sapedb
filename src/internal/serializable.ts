/**
 * What may be declared.
 *
 * A declaration is data and only data: it is stored, sent over a wire, listed
 * in a panel and read back by something that never loaded the code that wrote
 * it. A function in there would be lost on the first round trip, and the
 * consumer would be coupled to the declaring side — which is the one property
 * the split between declaring and running exists to keep.
 *
 * @internal
 */

export type Serializable = null | boolean | number | string | Serializable[] | { [key: string]: Serializable };

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "function") return "a function";
  if (typeof value === "symbol") return "a symbol";
  if (typeof value === "bigint") return "a bigint";
  if (value instanceof Date) return "a Date";
  if (value instanceof Map || value instanceof Set) return `a ${value.constructor.name}`;
  return `an instance of ${(value as object)?.constructor?.name ?? "an unknown class"}`;
}

/**
 * Throws unless `value` is data all the way down: null, booleans, numbers,
 * strings, arrays and plain objects. `undefined` is refused too — JSON drops
 * it, so a declaration carrying one means something different after a round
 * trip than it did when written.
 *
 * @param label - What to call it in the error, e.g. `"operation"`.
 * @throws TypeError naming the path that is not data.
 */
export function assertSerializable(value: unknown, label: string, path: string[] = [], seen = new Set<object>()): void {
  const at = path.length ? `${label}.${path.join(".")}` : label;

  if (value === null || typeof value === "boolean" || typeof value === "string") return;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`[ecosy/rsql] ${at} is ${value}, which JSON cannot carry`);
    return;
  }

  if (Array.isArray(value) || (typeof value === "object" && value !== null && isPlainObject(value))) {
    if (seen.has(value as object)) throw new TypeError(`[ecosy/rsql] ${at} is part of a cycle; a declaration must be a tree`);
    seen.add(value as object);

    if (Array.isArray(value)) {
      value.forEach((item, index) => assertSerializable(item, label, [...path, String(index)], seen));
    } else {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        assertSerializable(item, label, [...path, key], seen);
      }
    }

    seen.delete(value as object);
    return;
  }

  throw new TypeError(`[ecosy/rsql] ${at} is ${describe(value)}; a declaration must be data — it is stored and sent as JSON`);
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/** A frozen deep copy, so what was declared cannot be changed afterwards by whoever declared it. */
export function freezeDeep<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeDeep)) as Value;
  }
  if (value !== null && typeof value === "object" && isPlainObject(value as object)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) copy[key] = freezeDeep(item);
    return Object.freeze(copy) as Value;
  }
  return value;
}
