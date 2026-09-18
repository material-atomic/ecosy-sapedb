/**
 * The command bus: named execution.
 *
 * ```ts
 * import { Commander } from "@ecosy/rsql/commander";
 *
 * const AppCommands = Commander({ runner });
 * const bus = new AppCommands();
 *
 * bus.scope("orders").declare({
 *   name: "orders.open_by_customer",
 *   operation: { read: "orders", using: "open_by_total", where: [["customerId", "eq", "$customerId"]], limit: 100 },
 *   auth: ["orders.read"],
 * });
 *
 * await bus.run("orders.open_by_customer", { customerId }, "storefront");
 * ```
 *
 * Nothing here holds a handler. An operation is **data**: what it reads, which
 * index it walks, what it is allowed to return. Running it means handing that
 * data to a runner — the connection to a store, or a test double. Which is why
 * a consumer is never coupled to whoever declared it, and why the cost of an
 * operation can be known before it runs.
 */

import { assertSerializable, freezeDeep, type Serializable } from "../internal/serializable";
import { globalState } from "../internal/global-state";

/** Console-shaped; only `warn` is used. */
export interface CommanderLogger {
  warn(...args: unknown[]): void;
}

/** What a command requires of its caller. `true` is "signed in"; a list also requires those permissions, all of them. */
export type AuthRequirement = boolean | string | readonly string[];

/** An auth requirement, normalised. */
export interface AuthNeed {
  login: boolean;
  permissions: readonly string[];
}

/** One argument of a command, for a panel or a docs page to render. */
export interface ArgumentHint {
  name: string;
  type?: string;
  required?: boolean;
  example?: Serializable;
  about?: string;
}

/** A command, as data. */
export interface CommandDeclaration {
  /** Unique across the bus. By convention `{area}.{entity}.{verb}`. */
  name: string;
  /**
   * What the command does, in whatever shape the runner understands — the
   * declared operation: collection, index, bounds, projection, limits. Data
   * only; a function anywhere in here is refused.
   */
  operation: Serializable;
  /** Bumped when the operation changes in a way callers can see. */
  version?: number;
  description?: string;
  args?: readonly ArgumentHint[];
  returns?: string;
  /** Absent or `false` is public. */
  auth?: AuthRequirement;
}

/** A command as the bus holds it: what was declared, plus who declared it. */
export interface Command extends CommandDeclaration {
  readonly owner: string | null;
}

/** One line of the trace: what ran, for whom, how long, and how it ended. */
export interface TraceEntry {
  command: string;
  caller: string | null;
  /**
   * The **names** of the arguments, never their values. An audit log that
   * records values records passwords and tokens — the mistake this avoids by
   * construction rather than by remembering to redact.
   */
  args: readonly string[];
  ms: number;
  ok: boolean;
  rows?: number;
  error?: string;
  /** How deep in the tree of sub-commands this ran. */
  depth: number;
}

/** What a runner is handed. */
export interface RunRequest {
  command: Command;
  args: Record<string, unknown>;
  caller: string | null;
  /**
   * Runs another command inside this one, keeping the same trace and the same
   * cycle detection. A runner that reaches for the bus directly instead would
   * start a new root, and A → B → A would recurse forever.
   */
  run(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

export type Runner = (request: RunRequest) => unknown | Promise<unknown>;

export interface CommanderOptions {
  /** Executes a declared operation. The store's connection, or a double in tests. */
  runner: Runner;
  /**
   * Answers whether a caller meets a requirement. **Absent, every command that
   * declares one is refused** — a bus that cannot check is not a bus that
   * allows.
   */
  authorize?: (need: AuthNeed, caller: string | null, command: Command) => boolean | Promise<boolean>;
  logger?: CommanderLogger;
  /** Shares the registry on `globalThis` under this name, for hosts that evaluate a module more than once. */
  storageKey?: string;
}

export interface CommandScope {
  /** Declares a command owned by this scope. */
  declare(command: CommandDeclaration): void;
  has(name: string): boolean;
  /** Runs a command with this scope as the caller, so the trace needs no reminding. */
  run<Result = unknown>(name: string, args?: Record<string, unknown>): Promise<Result>;
  tryRun<Result = unknown>(name: string, args?: Record<string, unknown>, fallback?: Result): Promise<Result | undefined>;
}

export interface CommanderToken {
  /** Declares a command with no owner. Prefer {@link scope}. */
  declare(command: CommandDeclaration): void;
  /** Everything declared from here is attributed to `owner`, which nothing can claim for itself. */
  scope(owner: string): CommandScope;

  has(name: string): boolean;
  names(): string[];
  get(name: string): Command | undefined;
  ownerOf(name: string): string | null | undefined;
  namesOwnedBy(owner: string): string[];
  authOf(name: string): AuthNeed | null;

  run<Result = unknown>(name: string, args?: Record<string, unknown>, caller?: string): Promise<Result>;
  /** The same, answering `fallback` when the command is not declared or fails. */
  tryRun<Result = unknown>(name: string, args?: Record<string, unknown>, fallback?: Result, caller?: string): Promise<Result | undefined>;

  /** The trace of the last root run, most recent last. */
  traceLog(): readonly TraceEntry[];
}

export type CommanderClass = new () => CommanderToken;

export class CommandNotFound extends Error {
  constructor(readonly command: string) {
    super(`[ecosy/rsql] command not declared: ${command}`);
    this.name = "CommandNotFound";
  }
}

export class CommandUnauthorized extends Error {
  constructor(
    readonly command: string,
    readonly need: AuthNeed,
  ) {
    super(
      `[ecosy/rsql] ${command} requires ${need.permissions.length ? need.permissions.join(", ") : "a signed-in caller"}`,
    );
    this.name = "CommandUnauthorized";
  }
}

export class CommandCycle extends Error {
  constructor(readonly chain: readonly string[]) {
    super(`[ecosy/rsql] command cycle: ${chain.join(" → ")}`);
    this.name = "CommandCycle";
  }
}

function normaliseAuth(auth: AuthRequirement | undefined): AuthNeed | null {
  if (auth === undefined || auth === false) return null;
  if (auth === true) return { login: true, permissions: [] };

  const permissions = (typeof auth === "string" ? [auth] : [...auth]).map(String).filter((item) => item.length > 0);
  return { login: true, permissions: Object.freeze(permissions) };
}

function rowsOf(result: unknown): number | undefined {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === "object" && Array.isArray((result as { items?: unknown[] }).items)) {
    return (result as { items: unknown[] }).items.length;
  }
  return undefined;
}

/** One root run: its own stack and its own trace, so two runs in flight never see each other's. */
interface Session {
  stack: string[];
  trace: TraceEntry[];
}

/**
 * Builds a command bus class.
 *
 * The registry lives with the class, not its instances, so `new AppCommands()`
 * anywhere sees the same commands. Two `Commander()` calls are two buses.
 */
export function Commander(options: CommanderOptions): CommanderClass {
  if (typeof options?.runner !== "function") {
    throw new TypeError("[ecosy/rsql] Commander needs a runner");
  }

  const logger = options.logger ?? console;
  const state = globalState("commander", options.storageKey, () => ({
    commands: new Map<string, Command>(),
    auth: new Map<string, AuthNeed>(),
    lastTrace: [] as TraceEntry[],
  }));

  const declare = (owner: string | null, declaration: CommandDeclaration) => {
    if (typeof declaration?.name !== "string" || declaration.name.length === 0) {
      throw new TypeError("[ecosy/rsql] a command needs a name");
    }
    if (declaration.operation === undefined) {
      throw new TypeError(`[ecosy/rsql] ${declaration.name} needs an operation`);
    }

    assertSerializable(declaration.operation, `${declaration.name}.operation`);
    if (declaration.args !== undefined) assertSerializable(declaration.args, `${declaration.name}.args`);

    const previous = state.commands.get(declaration.name);
    if (previous && previous.owner !== null && owner !== null && previous.owner !== owner) {
      logger.warn(`[ecosy/rsql] "${owner}" replaced command "${declaration.name}" declared by "${previous.owner}"`);
    }

    /* A re-declaration replaces the whole descriptor. Keeping the old auth or
       meta beside a new operation is how a public command inherits a
       permission it never asked for, and is then refused with nothing to
       explain it. */
    state.auth.delete(declaration.name);

    const need = normaliseAuth(declaration.auth);
    if (need) state.auth.set(declaration.name, need);

    state.commands.set(declaration.name, freezeDeep({ ...declaration, owner }) as Command);
  };

  const execute = async (name: string, args: Record<string, unknown>, caller: string | null, session: Session): Promise<unknown> => {
    const command = state.commands.get(name);
    if (!command) {
      /* This never reaches the try/catch below, which is the only other place
         that pushes a trace line — so without this push a call that misses
         the registry leaves nothing anywhere. `tryRun` exists precisely to
         keep that miss from being noise; the trace line is what is left once
         it is. `depth` is read before anything is pushed, the same as the
         found-command path below, so a miss nested inside a running command
         lands at that command's depth, not always at zero. */
      const error = new CommandNotFound(name);
      session.trace.push({
        command: name,
        caller,
        args: Object.keys(args ?? {}),
        ms: 0,
        ok: false,
        error: error.message,
        depth: session.stack.length,
      });
      throw error;
    }

    const need = state.auth.get(name) ?? null;
    if (need) {
      if (!options.authorize) throw new CommandUnauthorized(name, need);
      if (!(await options.authorize(need, caller, command))) throw new CommandUnauthorized(name, need);
    }

    if (session.stack.includes(name)) {
      throw new CommandCycle([...session.stack, name]);
    }

    const depth = session.stack.length;
    session.stack.push(name);
    const startedAt = performance.now();

    try {
      const result = await options.runner({
        command,
        args,
        caller,
        run: (nested, nestedArgs = {}) => execute(nested, nestedArgs, name, session),
      });

      session.trace.push({
        command: name,
        caller,
        args: Object.keys(args ?? {}),
        ms: performance.now() - startedAt,
        ok: true,
        rows: rowsOf(result),
        depth,
      });

      return result;
    } catch (error) {
      session.trace.push({
        command: name,
        caller,
        args: Object.keys(args ?? {}),
        ms: performance.now() - startedAt,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        depth,
      });
      throw error;
    } finally {
      session.stack.pop();
    }
  };

  const run = async (name: string, args: Record<string, unknown>, caller: string | null) => {
    const session: Session = { stack: [], trace: [] };
    try {
      return await execute(name, args, caller, session);
    } finally {
      state.lastTrace = session.trace;
    }
  };

  return class CommanderImpl implements CommanderToken {
    declare(command: CommandDeclaration): void {
      declare(null, command);
    }

    scope(owner: string): CommandScope {
      if (typeof owner !== "string" || owner.length === 0) {
        throw new TypeError("[ecosy/rsql] a scope needs an owner name");
      }

      return {
        declare: (command) => declare(owner, command),
        has: (name) => state.commands.has(name),
        run: (name, args = {}) => run(name, args, owner) as Promise<never>,
        tryRun: async (name, args = {}, fallback?) => {
          try {
            return (await run(name, args, owner)) as never;
          } catch (error) {
            /* Only a lookup miss is a fallback's business. Anything else —
               a runner that threw, a caller that failed auth, a cycle — is a
               real failure, and swallowing it would make "nobody wired this
               up yet" and "the caller passed the wrong argument name" read as
               the same answer to whoever is holding the fallback value. */
            if (error instanceof CommandNotFound) return fallback as never;
            throw error;
          }
        },
      };
    }

    has(name: string): boolean {
      return state.commands.has(name);
    }

    names(): string[] {
      return [...state.commands.keys()].sort();
    }

    get(name: string): Command | undefined {
      return state.commands.get(name);
    }

    ownerOf(name: string): string | null | undefined {
      return state.commands.get(name)?.owner;
    }

    namesOwnedBy(owner: string): string[] {
      return this.names().filter((name) => state.commands.get(name)?.owner === owner);
    }

    authOf(name: string): AuthNeed | null {
      return state.auth.get(name) ?? null;
    }

    run<Result = unknown>(name: string, args: Record<string, unknown> = {}, caller?: string): Promise<Result> {
      return run(name, args, caller ?? null) as Promise<Result>;
    }

    async tryRun<Result = unknown>(
      name: string,
      args: Record<string, unknown> = {},
      fallback?: Result,
      caller?: string,
    ): Promise<Result | undefined> {
      try {
        return (await run(name, args, caller ?? null)) as Result;
      } catch (error) {
        /* Same reasoning as scope().tryRun above, duplicated because these
           two bodies are independent — fixing one and forgetting the other
           is exactly the bug this task exists to close. */
        if (error instanceof CommandNotFound) return fallback;
        throw error;
      }
    }

    traceLog(): readonly TraceEntry[] {
      return state.lastTrace;
    }
  };
}
