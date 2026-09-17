/**
 * The driver: connections, and the calls that travel over them.
 *
 * ```ts
 * import { Client } from "@ecosy/rsql/client";
 *
 * const AppStore = Client({ transport, storageKey: "app" });
 * const store = new AppStore();
 * const rows = await store.invoke(process.env.DATABASE_URL!, "orders.list", { limit: 20 });
 * ```
 *
 * Three things it is built around, each of them a decision rather than a
 * default:
 *
 * - **Nothing is opened at import or at boot.** The first call opens a
 *   connection. A store that cannot be reached must fail the calls that need
 *   it, not the process that happens to import this.
 * - **The account is the connection.** One socket serves every database of an
 *   account; nothing on it can reach another account's.
 * - **A write carries its own id.** A retry after a dropped connection sends
 *   the same id, so the store replays its answer instead of doing the work
 *   twice. Reads may be retried freely; writes are never retried without it.
 */

import { parseConnectionString, redact, type ConnectionTarget } from "../connection";
import { Refused, RsqlError, Unavailable } from "../errors";
import { ulid } from "../internal/id";
import { globalState } from "../internal/global-state";
import {
  decodeJsonPayload,
  encodeJsonFrame,
  FrameType,
  type Frame,
} from "../protocol";

/** Console-shaped; only `warn` is used. */
export interface ClientLogger {
  warn(...args: unknown[]): void;
}

/** A live connection to a store, as the driver needs it. Sockets, or something in a test. */
export interface Connection {
  send(bytes: Uint8Array): void;
  /** Every frame the store sends. */
  onFrame(handler: (frame: Frame) => void): void;
  /** Called once when the connection ends, for any reason. */
  onClose(handler: (reason?: unknown) => void): void;
  close(): void;
}

/** Opens connections. Node TLS, a Worker socket, or a double. */
export interface Transport {
  connect(target: ConnectionTarget): Promise<Connection>;
}

export interface ClientOptions {
  transport: Transport;
  /**
   * How a connection is scoped.
   *
   * - `"account"` (the default): one connection serves every database of an
   *   account, and each call names its database and carries its signature.
   *   A pool of a few sockets then serves any number of databases.
   * - `"bound"`: the database is fixed at the handshake and calls name none —
   *   the stricter shape, for a client that is not the app itself.
   */
  mode?: "account" | "bound";
  /** Milliseconds to wait for a connection. Default 5000. */
  connectTimeout?: number;
  /** Milliseconds to wait for an answer. Default 15000. */
  requestTimeout?: number;
  /** Milliseconds a connection may sit unused before it is closed. Default 60000. */
  idleTimeout?: number;
  /** Milliseconds between pings on an idle connection. `0` turns them off. Default 20000. */
  keepAlive?: number;
  breaker?: {
    /** Consecutive failures to open a connection before calls fail fast. Default 3. */
    failures?: number;
    /** Milliseconds to fail fast for. Default 5000. */
    cooldown?: number;
  };
  logger?: ClientLogger;
  /** Shares the pool on `globalThis` under this name, for hosts that evaluate a module more than once. */
  storageKey?: string;
}

export interface InvokeOptions {
  /**
   * A call that changes something. It is given an id, and a retry after a
   * dropped connection sends the same one — which is what lets the store tell
   * "do this again" from "you already did this, tell me what happened".
   */
  write?: boolean;
  /** Reuse an id from an earlier attempt, when the retry is the caller's own. */
  writeId?: string;
  /** Overrides {@link ClientOptions.requestTimeout}. */
  timeout?: number;
}

export interface PoolStats {
  /** Open connections, by pool key. */
  connections: number;
  /** Calls sent and not yet answered. */
  inFlight: number;
  /** Accounts the breaker is failing fast for. */
  tripped: string[];
}

export interface ClientToken {
  /** Calls a declared operation. The target is a connection string, or one already parsed. */
  invoke<Result = unknown>(
    target: string | ConnectionTarget,
    command: string,
    args?: Record<string, unknown>,
    options?: InvokeOptions,
  ): Promise<Result>;
  /** Round trip to the store — the same path everything else uses, so a health check proves the real thing. */
  ping(target: string | ConnectionTarget): Promise<number>;
  /** Closes every connection. Calls in flight are rejected. */
  close(): Promise<void>;
  stats(): PoolStats;
}

export type ClientClass = new () => ClientToken;

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Entry {
  key: string;
  target: ConnectionTarget;
  connection: Connection | null;
  opening: Promise<Connection> | null;
  pending: Map<number, Pending>;
  nextId: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  keepAliveTimer: ReturnType<typeof setInterval> | null;
}

interface Breaker {
  failures: number;
  openUntil: number;
}

const DEFAULTS = {
  connectTimeout: 5_000,
  requestTimeout: 15_000,
  idleTimeout: 60_000,
  keepAlive: 20_000,
  failures: 3,
  cooldown: 5_000,
};

function unref(timer: unknown): void {
  (timer as { unref?: () => void })?.unref?.();
}

/**
 * Builds a client class. The pool lives with the class, so every `new` shares
 * it; two `Client()` calls are two pools.
 */
export function Client(options: ClientOptions): ClientClass {
  if (typeof options?.transport?.connect !== "function") {
    throw new TypeError("[ecosy/rsql] Client needs a transport");
  }

  const mode = options.mode ?? "account";
  const connectTimeout = options.connectTimeout ?? DEFAULTS.connectTimeout;
  const requestTimeout = options.requestTimeout ?? DEFAULTS.requestTimeout;
  const idleTimeout = options.idleTimeout ?? DEFAULTS.idleTimeout;
  const keepAlive = options.keepAlive ?? DEFAULTS.keepAlive;
  const maxFailures = options.breaker?.failures ?? DEFAULTS.failures;
  const cooldown = options.breaker?.cooldown ?? DEFAULTS.cooldown;
  const logger = options.logger ?? console;

  const state = globalState("client", options.storageKey, () => ({
    entries: new Map<string, Entry>(),
    breakers: new Map<string, Breaker>(),
  }));

  const keyOf = (target: ConnectionTarget) =>
    mode === "bound"
      ? `${target.accountId}@${target.host}:${target.port}/${target.dbname}`
      : `${target.accountId}@${target.host}:${target.port}`;

  const settleAll = (entry: Entry, error: unknown) => {
    for (const pending of entry.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    entry.pending.clear();
  };

  const teardown = (entry: Entry, error?: unknown) => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.keepAliveTimer) clearInterval(entry.keepAliveTimer);
    entry.idleTimer = null;
    entry.keepAliveTimer = null;

    const connection = entry.connection;
    entry.connection = null;
    entry.opening = null;

    if (state.entries.get(entry.key) === entry) state.entries.delete(entry.key);

    settleAll(entry, error ?? new Unavailable("the connection closed"));
    try {
      connection?.close();
    } catch {
      // Closing a connection that is already gone is not an error worth having.
    }
  };

  const touch = (entry: Entry) => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (!idleTimeout) return;

    entry.idleTimer = setTimeout(() => {
      /* Only while nothing is waiting: an idle timer must never cut a call
         short. */
      if (entry.pending.size === 0) teardown(entry, new Unavailable("the connection was idle"));
    }, idleTimeout);
    unref(entry.idleTimer);
  };

  const handle = (entry: Entry, frame: Frame) => {
    if (frame.id === 0) return; // Events belong to a subscription, not to a call.

    const pending = entry.pending.get(frame.id);
    if (!pending) return;

    entry.pending.delete(frame.id);
    if (pending.timer) clearTimeout(pending.timer);
    touch(entry);

    if (frame.type === FrameType.failure) {
      const body = decodeJsonPayload<{ message?: string; code?: string }>(frame);
      pending.reject(new Refused(body?.message ?? "the store refused the call", body?.code ?? "refused"));
      return;
    }

    pending.resolve(frame.type === FrameType.pong ? null : decodeJsonPayload(frame));
  };

  const breakerFor = (target: ConnectionTarget) => {
    const key = `${target.accountId}@${target.host}:${target.port}`;
    return { key, breaker: state.breakers.get(key) ?? { failures: 0, openUntil: 0 } };
  };

  const open = async (entry: Entry): Promise<Connection> => {
    if (entry.connection) return entry.connection;
    if (entry.opening) return entry.opening;

    const { key: breakerKey, breaker } = breakerFor(entry.target);
    if (breaker.openUntil > Date.now()) {
      /* Fail fast rather than pay a connect timeout per call: a store that is
         down should cost the app a millisecond, not five seconds a request. */
      throw new Unavailable(`${redact(entry.target)} is not answering; not trying again for now`);
    }

    entry.opening = (async () => {
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Unavailable(`connecting to ${redact(entry.target)} timed out`)), connectTimeout);
        unref(timer);
      });

      const connection = await Promise.race([options.transport.connect(entry.target), timeout]);

      connection.onFrame((frame) => handle(entry, frame));
      connection.onClose((reason) => {
        if (state.entries.get(entry.key) === entry) {
          teardown(entry, new Unavailable("the store closed the connection", { cause: reason }));
        }
      });

      connection.send(
        encodeJsonFrame(FrameType.hello, 0, {
          account: entry.target.accountId,
          password: entry.target.password,
          sig: entry.target.sig,
          ...(mode === "bound" ? { dbname: entry.target.dbname } : {}),
          mode,
        }),
      );

      entry.connection = connection;

      if (keepAlive > 0) {
        entry.keepAliveTimer = setInterval(() => {
          if (entry.pending.size === 0 && entry.connection) {
            try {
              entry.connection.send(encodeJsonFrame(FrameType.ping, nextId(entry), null));
            } catch {
              teardown(entry, new Unavailable("the connection broke while idle"));
            }
          }
        }, keepAlive);
        unref(entry.keepAliveTimer);
      }

      touch(entry);
      return connection;
    })();

    try {
      const connection = await entry.opening;
      state.breakers.delete(breakerKey);
      return connection;
    } catch (error) {
      entry.opening = null;
      const failures = breaker.failures + 1;
      state.breakers.set(breakerKey, {
        failures,
        openUntil: failures >= maxFailures ? Date.now() + cooldown : 0,
      });

      if (failures === maxFailures) {
        logger.warn(`[ecosy/rsql] ${redact(entry.target)} failed ${failures} times; calls fail fast for ${cooldown}ms`);
      }

      teardown(entry, error);
      throw error instanceof RsqlError ? error : new Unavailable(`cannot reach ${redact(entry.target)}`, { cause: error });
    }
  };

  const entryFor = (target: ConnectionTarget): Entry => {
    const key = keyOf(target);
    const existing = state.entries.get(key);
    if (existing) return existing;

    const entry: Entry = {
      key,
      target,
      connection: null,
      opening: null,
      pending: new Map(),
      nextId: 0,
      idleTimer: null,
      keepAliveTimer: null,
    };
    state.entries.set(key, entry);
    return entry;
  };

  /** Ids wrap rather than grow: only the calls in flight have to be told apart. */
  function nextId(entry: Entry): number {
    do {
      entry.nextId = (entry.nextId % 0xffff_fffe) + 1;
    } while (entry.pending.has(entry.nextId));
    return entry.nextId;
  }

  const send = async (target: ConnectionTarget, type: number, body: Record<string, unknown>, timeout: number) => {
    const entry = entryFor(target);
    const connection = await open(entry);
    const id = nextId(entry);

    return new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { resolve, reject, timer: null };

      if (timeout > 0) {
        pending.timer = setTimeout(() => {
          entry.pending.delete(id);
          reject(new Unavailable(`${redact(target)} did not answer within ${timeout}ms`));
        }, timeout);
        unref(pending.timer);
      }

      entry.pending.set(id, pending);

      try {
        connection.send(encodeJsonFrame(type, id, body));
      } catch (error) {
        entry.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        teardown(entry, error);
        reject(new Unavailable("the connection broke while sending", { cause: error }));
      }
    });
  };

  const resolveTarget = (target: string | ConnectionTarget) =>
    typeof target === "string" ? parseConnectionString(target) : target;

  return class ClientImpl implements ClientToken {
    async invoke<Result = unknown>(
      target: string | ConnectionTarget,
      command: string,
      args: Record<string, unknown> = {},
      invokeOptions: InvokeOptions = {},
    ): Promise<Result> {
      if (typeof command !== "string" || command.length === 0) {
        throw new TypeError("[ecosy/rsql] invoke needs a command name");
      }

      const parsed = resolveTarget(target);
      const writeId = invokeOptions.write || invokeOptions.writeId ? (invokeOptions.writeId ?? ulid()) : undefined;

      const body: Record<string, unknown> = { command, args };
      if (mode === "account") {
        body.dbname = parsed.dbname;
        body.sig = parsed.sig;
      }
      if (writeId) body.writeId = writeId;

      try {
        return (await send(parsed, FrameType.invoke, body, invokeOptions.timeout ?? requestTimeout)) as Result;
      } catch (error) {
        /* One reconnect, and only for work that can be repeated safely: a read,
           or a write carrying the id that makes a repeat harmless. */
        if (error instanceof Unavailable && (!invokeOptions.write || writeId)) {
          return (await send(parsed, FrameType.invoke, body, invokeOptions.timeout ?? requestTimeout)) as Result;
        }
        throw error;
      }
    }

    async ping(target: string | ConnectionTarget): Promise<number> {
      const startedAt = performance.now();
      await send(resolveTarget(target), FrameType.ping, {}, requestTimeout);
      return performance.now() - startedAt;
    }

    async close(): Promise<void> {
      for (const entry of [...state.entries.values()]) {
        teardown(entry, new Unavailable("the client was closed"));
      }
      state.breakers.clear();
    }

    stats(): PoolStats {
      let inFlight = 0;
      for (const entry of state.entries.values()) inFlight += entry.pending.size;

      return {
        connections: state.entries.size,
        inFlight,
        tripped: [...state.breakers.entries()].filter(([, breaker]) => breaker.openUntil > Date.now()).map(([key]) => key),
      };
    }
  };
}
