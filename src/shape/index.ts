/**
 * The shape registry: discovery.
 *
 * Kept apart from the command bus because it answers a different question.
 * **Commander runs things; ShapeRegistry says what there is.** A shape is a
 * flat, serializable description — a label, a group, a widget, and the names of
 * the commands that serve it — so whoever reads it is never coupled to whoever
 * published it, and a panel written once for a `kind` serves every publisher of
 * that kind.
 *
 * ```ts
 * import { ShapeRegistry } from "@ecosy/rsql/shape";
 *
 * const Shapes = ShapeRegistry({ kinds: ["collection", "metric"] });
 * const shapes = new Shapes();
 *
 * shapes.scope("orders").declare("collection", "orders", {
 *   label: "Orders",
 *   commands: { list: "orders.open_by_customer", count: "orders.count_open" },
 * });
 *
 * shapes.of("collection"); // what a panel iterates
 * ```
 */

import { assertSerializable, freezeDeep, type Serializable } from "../internal/serializable";
import { globalState } from "../internal/global-state";

/** Console-shaped; only `warn` is used. */
export interface ShapeLogger {
  warn(...args: unknown[]): void;
}

/** What a publisher declares: data, and the names of the commands that serve it. */
export interface ShapeDeclaration {
  label?: string;
  group?: string;
  widget?: string;
  /** Role → command name. The role is the contract; the real names stay the publisher's business. */
  commands?: Record<string, string>;
  [key: string]: Serializable | undefined;
}

/** A shape as the registry holds it. */
export interface Shape extends ShapeDeclaration {
  readonly kind: string;
  readonly key: string;
  readonly owner: string | null;
}

export interface ShapeRegistryOptions {
  /**
   * The kinds that may be declared. Absent, any kind may be — expressive, and
   * a kind nothing understands can do nothing. Given, an unknown kind is
   * refused at declaration, where it is still cheap to notice.
   */
  kinds?: readonly string[];
  logger?: ShapeLogger;
  /** Shares the registry on `globalThis` under this name. */
  storageKey?: string;
}

export interface ShapeScope {
  declare(kind: string, key: string, shape: ShapeDeclaration): void;
  of(kind: string): readonly Shape[];
}

export interface ShapeRegistryToken {
  /** Declares a shape with no owner. Prefer {@link scope}. */
  declare(kind: string, key: string, shape: ShapeDeclaration): void;
  /** Everything declared from here is attributed to `owner`. */
  scope(owner: string): ShapeScope;

  /** Every shape of one kind. What a panel iterates. */
  of(kind: string): readonly Shape[];
  get(kind: string, key: string): Shape | undefined;
  has(kind: string, key: string): boolean;
  /** Every shape one publisher declared, of every kind. */
  ofOwner(owner: string): readonly Shape[];
  kinds(): string[];
}

export type ShapeRegistryClass = new () => ShapeRegistryToken;

/**
 * Builds a shape registry class. Like the command bus, the registry lives with
 * the class rather than its instances.
 */
export function ShapeRegistry(options: ShapeRegistryOptions = {}): ShapeRegistryClass {
  const logger = options.logger ?? console;
  const allowed = options.kinds ? new Set(options.kinds) : null;
  const state = globalState("shape", options.storageKey, () => new Map<string, Map<string, Shape>>());

  const declare = (owner: string | null, kind: string, key: string, shape: ShapeDeclaration) => {
    if (typeof kind !== "string" || kind.length === 0) throw new TypeError("[ecosy/rsql] a shape needs a kind");
    if (typeof key !== "string" || key.length === 0) throw new TypeError("[ecosy/rsql] a shape needs a key");
    if (allowed && !allowed.has(kind)) {
      throw new TypeError(`[ecosy/rsql] unknown shape kind "${kind}"; this registry takes ${[...allowed].join(", ")}`);
    }

    assertSerializable(shape ?? {}, `shape ${kind}/${key}`);

    const byKey = state.get(kind) ?? new Map<string, Shape>();
    const previous = byKey.get(key);

    /* Replacing another publisher's shape is allowed — the last one to boot
       wins, as with commands — but never silently: a panel drawing the wrong
       publisher's labels is otherwise a puzzle with no trace. */
    if (previous && previous.owner !== null && owner !== null && previous.owner !== owner) {
      logger.warn(`[ecosy/rsql] "${owner}" replaced shape ${kind}/${key} declared by "${previous.owner}"`);
    }

    byKey.set(key, freezeDeep({ ...shape, kind, key, owner }) as Shape);
    state.set(kind, byKey);
  };

  return class ShapeRegistryImpl implements ShapeRegistryToken {
    declare(kind: string, key: string, shape: ShapeDeclaration): void {
      declare(null, kind, key, shape);
    }

    scope(owner: string): ShapeScope {
      if (typeof owner !== "string" || owner.length === 0) {
        throw new TypeError("[ecosy/rsql] a scope needs an owner name");
      }

      return {
        declare: (kind, key, shape) => declare(owner, kind, key, shape),
        of: (kind) => this.of(kind),
      };
    }

    of(kind: string): readonly Shape[] {
      return Object.freeze([...(state.get(kind)?.values() ?? [])]);
    }

    get(kind: string, key: string): Shape | undefined {
      return state.get(kind)?.get(key);
    }

    has(kind: string, key: string): boolean {
      return state.get(kind)?.has(key) ?? false;
    }

    ofOwner(owner: string): readonly Shape[] {
      const out: Shape[] = [];
      for (const byKey of state.values()) {
        for (const shape of byKey.values()) if (shape.owner === owner) out.push(shape);
      }
      return Object.freeze(out);
    }

    kinds(): string[] {
      return [...state.keys()].sort();
    }
  };
}
