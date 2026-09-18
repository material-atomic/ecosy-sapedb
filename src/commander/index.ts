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
  /**
   * The same, answering `fallback` when and only when `name` **itself** —
   * the command this call asked for — is not declared. Every other
   * failure rethrows: the runner throwing, auth refusing, a cycle, and also
   * a `CommandNotFound` that some other lookup produced further down —
   * `name` declared and its runner calling a *different*, undeclared
   * command is a bug inside the command that ran, not "this command is
   * missing", and it throws rather than being reported as a fallback.
   *
   * If a runner genuinely wants a miss of its own to answer a fallback
   * rather than throw, it catches it where it makes the call:
   * `try { await request.run(other) } catch (e) { if (CommandNotFound.is(e)) … }`.
   * Reaching back for this method from inside a runner is not that — see
   * {@link RunRequest.run}, which explains why a runner that calls the bus
   * directly starts a new root and loses both the cycle check and the trace.
   *
   * The trace line left behind by a miss on this path carries this scope's
   * owner as `caller`, the same as {@link run} above, not an argument the
   * caller passed in.
   */
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
  /**
   * The same, answering `fallback` when and only when `name` **itself** —
   * the command this call asked for — is not declared in the registry.
   * Every other failure rethrows: the runner throwing, auth refusing, a
   * cycle, and also a `CommandNotFound` minted by some *other* lookup —
   * `name` declared and its runner going on to call a *different*,
   * undeclared command is a bug inside the command that ran, not "this
   * command is missing", so it throws instead of being folded into
   * `fallback`. A fallback that swallowed that shape too would make "nobody
   * wired this up yet" and "the command I run reaches for a name that does
   * not exist" read as the same answer.
   *
   * A runner that does want its own nested miss to answer a fallback catches
   * it at the call it makes:
   * `try { await request.run(other) } catch (e) { if (CommandNotFound.is(e)) … }`.
   * Calling this method from inside a runner is not the same thing and is
   * not the way to get it — see {@link RunRequest.run}: a runner reaching
   * back for the bus starts a fresh root, so the cycle check no longer sees
   * the commands already on the stack and the nested trace is discarded
   * instead of joining the one the caller will read.
   */
  tryRun<Result = unknown>(name: string, args?: Record<string, unknown>, fallback?: Result, caller?: string): Promise<Result | undefined>;

  /** The trace of the last root run, most recent last. */
  traceLog(): readonly TraceEntry[];
}

export type CommanderClass = new () => CommanderToken;

/*
 * Three brands, one `Symbol.for` each, one per error class below.
 *
 * `rollup.config.mjs` emits this module twice — once as ESM
 * (`dist/commander/index.mjs`), once as CJS (`dist/commander/index.js`) — and
 * `package.json`'s `exports` wires both to the same subpath, so a single Node
 * process that reaches this file through both `import` and `require` (which
 * `storageKey` in `internal/global-state.ts` exists precisely to let two
 * Commander instances do, on purpose, sharing one registry) ends up holding
 * two different classes named `CommandNotFound`. `instanceof` between an
 * instance from one and the class from the other is always `false`, even
 * though both throw for exactly the same reason.
 *
 * `Symbol.for` looks the symbol up in the runtime's global registry by string,
 * so a second copy of this module asking for the same string gets the exact
 * same symbol value — not a lookalike, the same one. `Symbol()` would not:
 * each build would mint its own, and nothing outside a single build could
 * ever tell the difference, which is exactly why that is the sharpest
 * mutation of this fix.
 *
 * Three separate symbols, not one shared between the three classes: a shared
 * brand would make `CommandUnauthorized.is(aCommandNotFound)` answer `true`,
 * and whoever is checking for an auth failure would swallow a lookup miss by
 * mistake instead.
 *
 * The three strings are published contract, not an implementation detail.
 * Two different *versions* of this package sitting in one `node_modules` — a
 * dedupe that did not happen — have to recognize each other's errors the same
 * way two builds of one version do, and a string in the global symbol
 * registry is the only thing they share. `commander.test.mjs` pins them
 * character for character for that reason. Changing one breaks nothing
 * loudly: `is()` just starts answering `false`, and a `tryRun` that used to
 * return a fallback starts throwing.
 *
 * Which matters for the rename in task 0038, because this package holds
 * **two** strings that carry its npm name and both answer the same question —
 * which copies of this package count as the same package. These three brands
 * are one; `Symbol.for("@ecosy/rsql/<namespace>:<storageKey>")` in
 * `internal/global-state.ts`, the key two builds share a registry under, is
 * the other. They move together or not at all. Move only the brands and two
 * builds go on sharing one registry while disagreeing about what a
 * `CommandNotFound` is — the exact breakage this comment exists to prevent.
 * Move only the registry key and two packages that no longer share a command
 * still claim each other's errors. Moving both is also what keeps a
 * migration install, old package and new one side by side, two separate buses
 * with two separate identities, which is what they are.
 *
 * Adding a fourth error class is three edits here, and only two of them fail
 * loudly: a `Symbol.for` line in this block, a `static is` on the class, and
 * an `Object.defineProperty` on its prototype below the class. Forget the
 * third and `is()` answers `false` for every instance the class ever mints,
 * with nothing red to say so.
 */
const NOT_FOUND_BRAND = Symbol.for("@ecosy/rsql.CommandNotFound");
const UNAUTHORIZED_BRAND = Symbol.for("@ecosy/rsql.CommandUnauthorized");
const CYCLE_BRAND = Symbol.for("@ecosy/rsql.CommandCycle");

/**
 * `error[brand] === true`, not `brand in error` — an object that carries the
 * key but sets it to `false` (or anything else) must not pass — and not a
 * bare property read on `error` without a type check first, because `null`
 * and `undefined` both throw on property access, and a runner is free to
 * throw either.
 */
function hasBrand(error: unknown, brand: symbol): boolean {
  return (typeof error === "object" || typeof error === "function") && error !== null && (error as Record<PropertyKey, unknown>)[brand] === true;
}

/**
 * Thrown when `execute` cannot find `command` in the registry — the one
 * failure {@link CommanderToken.tryRun} and {@link CommandScope.tryRun} both
 * swallow into a fallback.
 *
 * This package ships two builds — one ESM, one CJS, both wired to the same
 * subpath by `exports`, and a process reaching this module through `import`
 * and through `require` loads both (the source next to the brand symbols says
 * why that is on purpose; the generated `.d.ts` you may be reading this in
 * does not carry those module-private lines) —
 * so `error instanceof CommandNotFound` is only reliable inside a single one
 * of them — across the boundary it is always `false`, including for an error
 * this exact class threw a moment earlier in the other build. `CommandNotFound.is(error)`
 * is the version that holds everywhere: the brand behind it is a claim any
 * copy of this class can make (every copy registers the same `Symbol.for` key
 * and stamps its own prototype with it) and that nothing else has a reason to
 * make. Code outside this file — including a consumer's own `catch` — should
 * prefer `is()` to `instanceof` for the same reason.
 */
export class CommandNotFound extends Error {
  constructor(readonly command: string) {
    super(`[ecosy/rsql] command not declared: ${command}`);
    this.name = "CommandNotFound";
  }

  static is(error: unknown): error is CommandNotFound {
    return hasBrand(error, NOT_FOUND_BRAND);
  }
}
/*
 * On the prototype, not set per-instance in the constructor: `is()` has to
 * recognize anything that INHERITS the brand, not only what this
 * constructor personally minted. The real case is an error that crossed a
 * worker, a process, or `structuredClone` — all three drop the concrete
 * class but leave a plain object behind, and the receiving side recovers it
 * by hand with `Object.setPrototypeOf(plain, CommandNotFound.prototype)`.
 * That object never ran through `new CommandNotFound(...)`, so a brand
 * stamped per-instance in the constructor would not be on it; a brand on
 * the prototype is, because it walks the same chain `setPrototypeOf` just
 * joined.
 *
 * `Object.keys` and `JSON.stringify` never see a symbol key no matter where
 * it lives, and a non-enumerable one is invisible to a spread too — so none
 * of the three tell this placement apart from stamping the brand on the
 * instance instead, and none of them were ever evidence for choosing one
 * over the other. What IS evidence: `Object.getOwnPropertySymbols` on an
 * instance reports `[]` here and would report the brand if it were set in
 * the constructor instead (that function ignores `enumerable` entirely —
 * it lists every own symbol key), and `is()` on a bare `setPrototypeOf`
 * object answers `true` here and would answer `false` there, because that
 * object owns nothing of its own; everything it has, it has by inheriting
 * from the prototype. `enumerable: false` is what keeps this property out
 * of a spread; it buys nothing against `Object.getOwnPropertySymbols` or
 * against `is()`, since neither one filters by `enumerable`.
 */
Object.defineProperty(CommandNotFound.prototype, NOT_FOUND_BRAND, { value: true, enumerable: false });

/** See {@link CommandNotFound} for why this is a brand-checked `is()` rather than `instanceof`. */
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

  static is(error: unknown): error is CommandUnauthorized {
    return hasBrand(error, UNAUTHORIZED_BRAND);
  }
}
Object.defineProperty(CommandUnauthorized.prototype, UNAUTHORIZED_BRAND, { value: true, enumerable: false });

/** See {@link CommandNotFound} for why this is a brand-checked `is()` rather than `instanceof`. */
export class CommandCycle extends Error {
  constructor(readonly chain: readonly string[]) {
    super(`[ecosy/rsql] command cycle: ${chain.join(" → ")}`);
    this.name = "CommandCycle";
  }

  static is(error: unknown): error is CommandCycle {
    return hasBrand(error, CYCLE_BRAND);
  }
}
Object.defineProperty(CommandCycle.prototype, CYCLE_BRAND, { value: true, enumerable: false });

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
 * Stamped on a `CommandNotFound` when, and only when, the lookup that
 * minted it is the ROOT lookup of a call — `session.stack.length === 0`,
 * meaning no command is already running in this session when `execute`
 * looks `name` up. `tryExecute` below reads this stamp instead of comparing
 * `error.command === name`, because a name comparison cannot tell "I looked
 * this up and missed" apart from "something downstream, reaching for the
 * exact same name, looked it up and missed" — a facade bus that delegates
 * to a backend bus under the same command name is the single most common
 * shape two buses take, and it defeats a name comparison every time.
 *
 * `Symbol()`, deliberately UNREGISTERED — the opposite of the three
 * `Symbol.for` brands a hundred lines up, and opposite on purpose, not an
 * oversight to "fix" for symmetry. Those brands have to survive two builds
 * of this module meeting in one process: a `CommandNotFound` thrown by the
 * CJS build must still answer `true` to the ESM build's `is()`, because
 * it is the same kind of error either way — that is why they sit in the
 * runtime's global symbol registry under a shared string. This mark must
 * NOT survive that boundary the way the brands do: a root miss minted by
 * the *other* build's own root call is the root of *that* build's own
 * session, never of this build's.
 *
 * Measured, not assumed: swapping this one `Symbol()` for `Symbol.for` —
 * alone, leaving the `=== session` comparison below untouched — does NOT
 * turn any test red, including the ESM/CJS same-name bridging test built
 * specifically to exercise this shape (`commander-dual-build.test.mjs`).
 * The reason is the comparison, not the key: what actually stops a bridged
 * miss from being mistaken for this call's own root miss is comparing
 * against the exact `session` OBJECT, which is created fresh per call and
 * never exposed outside this module (not on `RunRequest`, not returned by
 * anything public) — so nothing outside this closure can ever construct a
 * value that would satisfy `=== session`, whether the key that reaches it
 * is private or registered. A registered key only lets outside code reach
 * the property at all, which needs a matching value to do anything with;
 * an unregistered one removes that reach entirely, for free, at zero
 * runtime cost — worth keeping for that reason, but it is not the thing
 * carrying this fix's correctness, and no test here claims otherwise.
 *
 * One consequence for the rename in task 0038, said here because this is the
 * line a search for the package name lands on. The comment above the three
 * brands counts **two** strings in this package that carry its npm name and
 * have to move together — those brands, and the registry key in
 * `internal/global-state.ts`. That count is still right, and this string is
 * deliberately not in it. Because the symbol is unregistered, the string
 * inside it is never looked up and never compared against anything; it is a
 * label that shows up when someone prints the property key in a debugger,
 * and nothing else reads it. Renaming it alone breaks nothing, and leaving
 * it behind while the other two move breaks nothing either. It is called out
 * here so it is not mistaken for a third member of that pair and "made
 * symmetrical" with them — the symmetry is the bug, as the paragraph above
 * explains.
 */
const ROOT_MISS = Symbol("@ecosy/rsql rootMiss"); // module-private; NOT exported, NOT Symbol.for

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
      if (session.stack.length === 0) {
        /* `=== 0`, not `<= 0`: `session.stack.length` is a `string[]`'s
           `.length`, which is never negative, so the two conditions are
           mathematically equivalent over every value this can ever hold —
           measured by mutating one into the other and finding no test able
           to tell them apart. `=== 0` is kept because it says what is
           actually meant ("nothing is running yet"), where `<= 0` reads as
           a guard against a case (`< 0`) that cannot occur.

           Only a ROOT lookup gets the stamp — the value is `session` itself,
           not `true`. `true` would only say "some root miss happened
           somewhere"; a bare boolean can't tell this session's own root miss
           apart from a root miss stamped by a bridged call through a
           different bus that happens to share this module (the same-name
           facade-to-backend shape ROOT_MISS exists to catch). Storing the
           exact `session` object and comparing with `===` in `tryExecute`
           is what makes the check "is this THE lookup this call made", not
           merely "is this A root miss". `Object.defineProperty` with its
           defaults (non-writable, non-configurable, non-enumerable) is
           enough — nothing here needs those to be relaxed. */
        Object.defineProperty(error, ROOT_MISS, { value: session });
      }
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

  /**
   * The one body behind both {@link CommandScope.tryRun} and
   * {@link CommanderToken.tryRun}. 0028 round 1 kept these as two
   * independent bodies on purpose, reasoning that a scope's `tryRun` and
   * the bus's own differ enough (a fixed `caller`, a fixed owner) to be
   * worth writing twice. Task 0041 adds a condition neither body had
   * before — the `ROOT_MISS` check — and a second mention of a mistake is
   * twice the chance to get one of the two copies wrong and not the other.
   * The cheapest way to not forget the second body is to not have one.
   *
   * What that trade moved rather than removed, said plainly so the next
   * person does not have to find it: before this task both `tryRun` bodies
   * went through `run` above, so whatever `run` did, `tryRun` did too. They
   * no longer do — this calls `execute` directly. `run` and `tryExecute` are
   * now siblings that each open a session and each close it by writing
   * `state.lastTrace`, and anything added to one of those two jobs has to be
   * added to both or `tryRun` quietly stops matching `run`.
   *
   * This cannot simply call `run` to close that gap, which is the obvious
   * thing to try: the whole check below is `=== session`, an identity test
   * against the exact session object this call created, and `run` keeps its
   * session to itself. Delegating would leave nothing here to compare
   * against.
   */
  const tryExecute = async <Result>(
    name: string,
    args: Record<string, unknown>,
    caller: string | null,
    fallback: Result | undefined,
  ): Promise<Result | undefined> => {
    const session: Session = { stack: [], trace: [] };
    try {
      return (await execute(name, args, caller, session)) as Result;
    } catch (error) {
      /* Only the ROOT lookup of THIS call is a fallback's business. A
         CommandNotFound minted deeper in the same session — the runner of
         a command that IS declared reaching for a name that is not — is a
         bug inside that command, not "this command is missing", and it
         rethrows. So does a CommandNotFound stamped by some other bus's own
         root lookup (a different session, or a different build entirely) —
         it says nothing about whether `name` is in THIS registry. Checking
         `error.command === name` instead would pass all of that: a facade
         bus delegating to a backend bus under the same command name is the
         ordinary shape of two buses meeting, and that shape mints an error
         whose `.command` is exactly the name this call asked for even
         though it came from someone else's lookup entirely.

         `CommandNotFound.is(error) &&` is redundant as a CLASS CHECK: by
         construction, the ONLY object that can ever satisfy
         `[ROOT_MISS] === session` is the exact `CommandNotFound` `execute`
         minted moments earlier for THIS session's root lookup —
         `ROOT_MISS` is a private symbol never exported, `session` is never
         exposed on `RunRequest` or anywhere else public, and the only place
         that ever calls `Object.defineProperty(_, ROOT_MISS, …)` is right
         there in `execute`'s not-found branch, on the object it just
         constructed. There is no way, through this module's public
         surface, for a caller's runner to get its hands on a *different*
         object stamped with *this* session — by the time a runner runs at
         all, this session's stack already has at least one entry, so
         nothing minted while a runner is running can ever be this
         session's root miss. Measured, not assumed: swapping
         `CommandNotFound.is(error)` for `error instanceof CommandNotFound`,
         for `error instanceof Error`, or for
         `(error as { name?: unknown })?.name === "CommandNotFound"` — each
         ANDed with the exact same `[ROOT_MISS] === session` — turns no test
         in this repository red, because whenever the right-hand side is
         true the left-hand side is true no matter which of the four it is.

         But `is(error) &&` is NOT removable, because a runner is free to
         `throw null` or `throw undefined` — the same case `hasBrand`
         (:236–242, a few hundred lines above) exists to guard against —
         and `error[ROOT_MISS]` on either of those throws a `TypeError`
         instead of letting the original `null`/`undefined` rethrow.
         `is(error)` is what stands in front of that property read and
         returns `false` before it happens; that is the half of this `&&`
         doing the deciding, not the class check. Measured: dropping only
         `CommandNotFound.is(error) &&` and keeping
         `[ROOT_MISS] === session` alone turns
         "tryRun rethrows null thrown by the runner…" red — a `TypeError:
         Cannot read properties of null (reading 'Symbol(...)')` where the
         test expects `null` itself to come back out. It also still
         documents which error this branch is actually about, and is the
         one of the four class checks that would start mattering again the
         day `ROOT_MISS`'s own guarantee is ever loosened — the other three
         would then silently paper over exactly the mistake `is()` exists
         to catch everywhere else in this file. */
      if (CommandNotFound.is(error) && (error as unknown as Record<PropertyKey, unknown>)[ROOT_MISS] === session) {
        return fallback;
      }
      throw error;
    } finally {
      /* Load-bearing: this is what leaves a trace behind even when the call
         ends in a fallback rather than a throw. Easiest thing to drop when
         collapsing two bodies into one — there is now only one `finally` to
         remember, but also only one place left where forgetting it would
         hide. */
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
        tryRun: (name, args = {}, fallback?) => tryExecute(name, args, owner, fallback) as Promise<never>,
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

    tryRun<Result = unknown>(
      name: string,
      args: Record<string, unknown> = {},
      fallback?: Result,
      caller?: string,
    ): Promise<Result | undefined> {
      return tryExecute(name, args, caller ?? null, fallback);
    }

    traceLog(): readonly TraceEntry[] {
      return state.lastTrace;
    }
  };
}
