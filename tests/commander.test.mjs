/* Against the built package in dist/, the thing that ships. */
import { test } from "node:test";
import assert from "node:assert/strict";

const { Commander, CommandNotFound, CommandUnauthorized, CommandCycle } = await import(
  new URL("../dist/commander/index.mjs", import.meta.url).href
);

const quiet = { warn() {} };
const recorder = () => {
  const lines = [];
  return { lines, warn: (...args) => lines.push(args.join(" ")) };
};

/** A runner that answers from a table, and can call other commands. */
const table = (answers = {}) => {
  const calls = [];
  const runner = async ({ command, args, caller, run }) => {
    calls.push({ name: command.name, args, caller });
    const answer = answers[command.name];
    return typeof answer === "function" ? answer({ command, args, run }) : answer;
  };
  return { runner, calls };
};

const listOrders = {
  name: "orders.list",
  operation: { read: "orders", using: "by_created", limit: 100 },
  description: "Open orders, newest first",
};

test("a command is data: what it reads, not how", async () => {
  const { runner, calls } = table({ "orders.list": [{ id: 1 }, { id: 2 }] });
  const bus = new (Commander({ runner, logger: quiet }))();

  bus.scope("orders").declare(listOrders);

  assert.deepEqual(bus.names(), ["orders.list"]);
  assert.equal(bus.ownerOf("orders.list"), "orders");
  assert.deepEqual(bus.get("orders.list").operation, { read: "orders", using: "by_created", limit: 100 });

  const result = await bus.run("orders.list", { limit: 2 }, "panel");
  assert.deepEqual(result, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(calls, [{ name: "orders.list", args: { limit: 2 }, caller: "panel" }]);
});

test("a declaration must be data all the way down", () => {
  const bus = new (Commander({ runner: async () => null, logger: quiet }))();

  for (const operation of [
    { read: "orders", where: () => true },
    { read: "orders", at: new Date() },
    { read: "orders", tags: new Set(["a"]) },
    { read: "orders", limit: undefined },
    { read: "orders", limit: Infinity },
  ]) {
    assert.throws(() => bus.declare({ name: "x", operation }), TypeError, JSON.stringify(Object.keys(operation)));
  }

  const cycle = { read: "orders" };
  cycle.self = cycle;
  assert.throws(() => bus.declare({ name: "x", operation: cycle }), /cycle/);

  assert.throws(() => bus.declare({ name: "", operation: {} }), TypeError);
  assert.throws(() => bus.declare({ name: "x" }), TypeError, "an operation is required");
});

test("what was declared cannot be changed afterwards", () => {
  const bus = new (Commander({ runner: async () => null, logger: quiet }))();
  const operation = { read: "orders", limit: 10 };
  bus.declare({ name: "orders.list", operation });

  operation.limit = 1_000_000;
  assert.equal(bus.get("orders.list").operation.limit, 10, "the copy the bus holds is its own");
  assert.throws(() => {
    bus.get("orders.list").operation.limit = 5;
  }, TypeError);
});

test("re-declaring replaces the whole descriptor, and says so across owners", async () => {
  const logger = recorder();
  const { runner } = table({ "orders.list": [] });
  const bus = new (Commander({ runner, logger, authorize: async () => false }))();

  bus.scope("orders").declare({ ...listOrders, auth: ["orders.read"] });
  await assert.rejects(() => bus.run("orders.list"), CommandUnauthorized);

  // The same name, declared public by someone else: the permission must not survive.
  bus.scope("reports").declare({ name: "orders.list", operation: { read: "orders" } });
  assert.equal(bus.authOf("orders.list"), null);
  await bus.run("orders.list");

  assert.equal(logger.lines.filter((line) => line.includes("replaced command")).length, 1);
});

test("auth is fail-closed: no authorizer, no run", async () => {
  const { runner } = table({ "orders.list": [] });
  const closed = new (Commander({ runner, logger: quiet }))();
  closed.declare({ ...listOrders, auth: true });
  await assert.rejects(() => closed.run("orders.list"), CommandUnauthorized);

  const seen = [];
  const open = new (Commander({
    runner,
    logger: quiet,
    authorize: (need, caller, command) => {
      seen.push({ need, caller, command: command.name });
      return caller === "panel";
    },
  }))();
  open.declare({ ...listOrders, auth: ["orders.read", "orders.list"] });

  await assert.rejects(() => open.run("orders.list", {}, "storefront"), CommandUnauthorized);
  await open.run("orders.list", {}, "panel");

  assert.deepEqual(seen[0].need, { login: true, permissions: ["orders.read", "orders.list"] });
  assert.equal(seen.length, 2);
});

test("auth shapes: true is signed-in, a string is one permission, false and absent are public", async () => {
  const { runner } = table({ a: 1, b: 1, c: 1, d: 1 });
  const bus = new (Commander({ runner, logger: quiet, authorize: () => true }))();

  bus.declare({ name: "a", operation: {}, auth: true });
  bus.declare({ name: "b", operation: {}, auth: "orders.read" });
  bus.declare({ name: "c", operation: {}, auth: false });
  bus.declare({ name: "d", operation: {} });

  assert.deepEqual(bus.authOf("a"), { login: true, permissions: [] });
  assert.deepEqual(bus.authOf("b"), { login: true, permissions: ["orders.read"] });
  assert.equal(bus.authOf("c"), null);
  assert.equal(bus.authOf("d"), null);
});

test("a command that is not declared throws from run; tryRun and a scope's tryRun both answer the fallback, or undefined with none given", async () => {
  const { runner } = table({});
  const bus = new (Commander({ runner, logger: quiet }))();

  await assert.rejects(() => bus.run("nothing.here"), CommandNotFound);
  assert.equal(await bus.tryRun("nothing.here", {}, "fallback"), "fallback");
  assert.equal(await bus.tryRun("nothing.here"), undefined);
  assert.equal(await bus.scope("orders").tryRun("missing", {}, "fallback"), "fallback");
  // The name promises "or undefined with none given" for BOTH tryRun and a
  // scope's tryRun, not just the bus's — round 1 asserted this on the bus
  // path only, leaving the scope path free to answer `null` or anything else
  // and still pass a test whose name claimed to cover it.
  assert.equal(await bus.scope("orders").tryRun("missing"), undefined);
});

/* This is the test that used to assert the opposite: `failing.tryRun("boom", ...)`
   answering "fallback" for a runner that actually failed. That was the bug — a
   declared command whose runner blew up read exactly like a command nobody had
   ever declared. Now it must throw, and the identity check (not a message
   comparison) is what stops an implementation that re-wraps the error from
   sneaking back in: a wrapped error can carry the same `.message` and still be
   a different mistake hiding behind the fallback. */
test("tryRun rethrows when a declared command's runner throws, keeping the runner's own error identity", async () => {
  const boom = new Error("the store is down");
  const failing = new (Commander({
    runner: async () => {
      throw boom;
    },
    logger: quiet,
  }))();
  failing.declare({ name: "boom", operation: {} });

  await assert.rejects(
    () => failing.tryRun("boom", {}, "fallback"),
    (error) => error === boom,
  );
});

/* Six shapes of "the runner failed", each run through both independent bodies —
   `CommanderImpl.tryRun` and `scope().tryRun` — because fixing one and leaving
   the other on `catch { return fallback }` is exactly the bug this task closes,
   and a test that only exercises one body would let that half-fix stand. */
test("tryRun rethrows a plain Error thrown by the runner, through both the bus and a scope, with the same error object", async () => {
  const boom = new Error("boom");
  const bus = new (Commander({
    runner: () => {
      throw boom;
    },
    logger: quiet,
  }))();
  bus.declare({ name: "x", operation: {} });

  await assert.rejects(
    () => bus.tryRun("x", {}, "fallback"),
    (error) => error === boom,
  );
  await assert.rejects(
    () => bus.scope("s").tryRun("x", {}, "fallback"),
    (error) => error === boom,
  );
});

test("tryRun rethrows a non-Error value thrown by the runner, through both the bus and a scope", async () => {
  const bus = new (Commander({
    runner: () => {
      throw "một chuỗi";
    },
    logger: quiet,
  }))();
  bus.declare({ name: "x", operation: {} });

  await assert.rejects(
    () => bus.tryRun("x", {}, "fallback"),
    (error) => error === "một chuỗi",
  );
  await assert.rejects(
    () => bus.scope("s").tryRun("x", {}, "fallback"),
    (error) => error === "một chuỗi",
  );
});

test("tryRun rethrows when the runner's promise rejects, through both the bus and a scope, keeping the rejection reason", async () => {
  const boom = new Error("store timeout");
  const bus = new (Commander({
    runner: async () => {
      throw boom;
    },
    logger: quiet,
  }))();
  bus.declare({ name: "x", operation: {} });

  await assert.rejects(
    () => bus.tryRun("x", {}, "fallback"),
    (error) => error === boom,
  );
  await assert.rejects(
    () => bus.scope("s").tryRun("x", {}, "fallback"),
    (error) => error === boom,
  );
});

test("tryRun rethrows CommandUnauthorized, through both the bus and a scope", async () => {
  const bus = new (Commander({ runner: () => "never runs", logger: quiet }))();
  bus.declare({ name: "x", operation: {}, auth: ["x.read"] });

  await assert.rejects(() => bus.tryRun("x", {}, "fallback"), CommandUnauthorized);
  await assert.rejects(() => bus.scope("s").tryRun("x", {}, "fallback"), CommandUnauthorized);
});

test("tryRun rethrows CommandCycle, through both the bus and a scope", async () => {
  const bus = new (Commander({ runner: ({ run }) => run("x"), logger: quiet }))();
  bus.declare({ name: "x", operation: {} });

  await assert.rejects(() => bus.tryRun("x", {}, "fallback"), CommandCycle);
  await assert.rejects(() => bus.scope("s").tryRun("x", {}, "fallback"), CommandCycle);
});

test("tryRun rethrows a TypeError raised by the bus itself, through both the bus and a scope", async () => {
  const bus = new (Commander({
    runner: () => {
      bus.scope("");
    },
    logger: quiet,
  }))();
  bus.declare({ name: "x", operation: {} });

  await assert.rejects(() => bus.tryRun("x", {}, "fallback"), TypeError);
  await assert.rejects(() => bus.scope("s").tryRun("x", {}, "fallback"), TypeError);
});

/* The knife: an implementation that compares `error.name === "CommandNotFound"`
   (or `error?.name`) instead of `instanceof CommandNotFound` passes every test
   above and still gets this one wrong. */
test("tryRun does not mistake an Error merely named CommandNotFound for an actual lookup miss, through both the bus and a scope", async () => {
  const impostor = new Error("[ecosy/rsql] command not declared: x");
  impostor.name = "CommandNotFound";
  const bus = new (Commander({
    runner: () => {
      throw impostor;
    },
    logger: quiet,
  }))();
  bus.declare({ name: "x", operation: {} });

  await assert.rejects(
    () => bus.tryRun("x", {}, "fallback"),
    (error) => error === impostor,
  );
  await assert.rejects(
    () => bus.scope("s").tryRun("x", {}, "fallback"),
    (error) => error === impostor,
  );
});

test("tryRun does not mistake a plain object shaped like CommandNotFound for an actual lookup miss, through both the bus and a scope", async () => {
  const impostor = { name: "CommandNotFound" };
  const bus = new (Commander({
    runner: () => {
      throw impostor;
    },
    logger: quiet,
  }))();
  bus.declare({ name: "x", operation: {} });

  await assert.rejects(
    () => bus.tryRun("x", {}, "fallback"),
    (error) => error === impostor,
  );
  await assert.rejects(
    () => bus.scope("s").tryRun("x", {}, "fallback"),
    (error) => error === impostor,
  );
});

test("tryRun rethrows null thrown by the runner, through both the bus and a scope, keeping the value null rather than turning it into some other error", async () => {
  const bus = new (Commander({
    runner: () => {
      throw null;
    },
    logger: quiet,
  }))();
  bus.declare({ name: "x", operation: {} });

  await assert.rejects(
    () => bus.tryRun("x", {}, "fallback"),
    (error) => error === null,
  );
  await assert.rejects(
    () => bus.scope("s").tryRun("x", {}, "fallback"),
    (error) => error === null,
  );
});

/* This is the contract, asserted directly at the `is()` layer rather than
   through tryRun: a plain object that deliberately carries the exact brand
   key set to `true` IS a CommandNotFound as far as `is()` is concerned. That
   is the whole point of a brand rather than a class check — and it must not
   be confused with the impostor tests above, which assert the opposite thing
   (a lookalike that does NOT carry the brand is rejected). Mixing the two
   into one test would leave neither claim readable. */
test("CommandNotFound.is() answers true for a bare object that carries the exact brand key — the contract a brand exists to make, not a shortcut through tryRun", () => {
  const branded = { [Symbol.for("@ecosy/rsql.CommandNotFound")]: true };
  assert.equal(CommandNotFound.is(branded), true);
});

test("CommandNotFound.is() answers false for null, undefined, and primitives without throwing", () => {
  for (const value of [null, undefined, "x", 0, false, Symbol("x")]) {
    assert.equal(CommandNotFound.is(value), false);
  }
});

/* The knife for `BRAND in error` in place of `error[BRAND] === true`: `in`
   only asks whether the key exists, so an object that carries the key but
   sets it to `false` would wrongly pass. The brand is a claim of `true`,
   not merely a key's presence. */
test("CommandNotFound.is() answers false for an object whose brand key is present but explicitly false", () => {
  const impostor = { [Symbol.for("@ecosy/rsql.CommandNotFound")]: false };
  assert.equal(CommandNotFound.is(impostor), false);
});

/* The brand living on the prototype rather than the instance IS observable —
   just not through `Object.keys`, a spread, or `JSON.stringify` (all three
   strip symbol keys no matter where those keys live, so none of them can
   tell the two placements apart). Two things do tell them apart:
   `Object.getOwnPropertySymbols` only reports symbols the instance itself
   carries, and `is()` must answer `true` for a plain object that inherits
   the brand through `Object.setPrototypeOf` without ever having run through
   `new CommandNotFound(...)` — that is the shape an error takes coming back
   from `structuredClone` across a worker or process boundary, which drops
   the prototype chain of the concrete class but not a `setPrototypeOf` onto
   this exact prototype done by hand on the receiving side. A brand stamped
   per-instance in the constructor would fail both: it would show up in
   `getOwnPropertySymbols`, and a plain object given this prototype afterward
   would not inherit anything, because there would be nothing on the
   prototype to inherit. */
test("CommandNotFound's brand lives on the prototype: an instance carries no own symbol keys, and a plain object reparented onto the prototype is recognized without being constructed", () => {
  const err = new CommandNotFound("x");
  assert.deepEqual(Object.getOwnPropertySymbols(err), []);

  const reparented = Object.setPrototypeOf({}, CommandNotFound.prototype);
  assert.equal(CommandNotFound.is(reparented), true);
});

/* Falsy fallbacks must come back exactly as given, through both independent
   bodies. `?? null`, `|| something`, or `return null` in place of `return
   fallback` all pass every earlier test (none of them pass a falsy fallback)
   and all fail this one. `strictEqual` (not `equal`) so a `null` given cannot
   quietly land as `undefined`. */
test("tryRun returns a falsy fallback unchanged, through both the bus and a scope", async () => {
  const { runner } = table({});
  const bus = new (Commander({ runner, logger: quiet }))();

  const cases = [
    ["not given", []],
    ["null", [null]],
    ["0", [0]],
    ["false", [false]],
    ["empty string", [""]],
  ];

  for (const [label, fallbackArgs] of cases) {
    assert.strictEqual(await bus.tryRun("missing", {}, ...fallbackArgs), fallbackArgs[0], `bus, ${label}`);
    assert.strictEqual(await bus.scope("orders").tryRun("missing", {}, ...fallbackArgs), fallbackArgs[0], `scope, ${label}`);
  }
});

/* `caller` on the trace line of a lookup miss reached through a scope must be
   that scope's owner — not a constant, not the argument the caller happened
   to pass (scope().tryRun takes no caller argument at all), and not dropped
   to null. Two different owners producing two different values is what rules
   out a lucky constant. */
test("a scope's tryRun traces its own owner as caller on a lookup miss, and two scopes trace two different owners", async () => {
  const { runner } = table({});
  const bus = new (Commander({ runner, logger: quiet }))();

  await bus.scope("orders").tryRun("missing", { a: 1 }, "fallback");
  let trace = bus.traceLog();
  assert.equal(trace.length, 1);
  assert.equal(trace[0].command, "missing");
  assert.equal(trace[0].caller, "orders");
  assert.deepEqual(trace[0].args, ["a"]);
  assert.equal(trace[0].ok, false);
  assert.equal(trace[0].depth, 0);

  await bus.scope("billing").tryRun("missing");
  trace = bus.traceLog();
  assert.equal(trace[0].caller, "billing", "a different scope must trace a different caller, not a constant");

  // scope().run (not tryRun) already had a test reading the owner through the
  // runner's own record of `caller` (below, "a scope binds the caller and the
  // owner…"); this is the same claim read through the trace instead, which is
  // the thing a fallback path actually has to go on.
  const { runner: listRunner } = table({ "orders.list": [] });
  const withList = new (Commander({ runner: listRunner, logger: quiet }))();
  withList.scope("orders").declare(listOrders);
  await withList.scope("orders").run("orders.list");
  assert.equal(withList.traceLog()[0].caller, "orders");
});

test("a fallback from a missing command leaves exactly one trace line, naming the command, caller, and argument names", async () => {
  const { runner } = table({});
  const bus = new (Commander({ runner, logger: quiet }))();

  await bus.tryRun("nothing.here", { a: 1 }, "fallback", "panel");
  const trace = bus.traceLog();

  assert.equal(trace.length, 1);
  assert.equal(trace[0].ok, false);
  assert.equal(trace[0].command, "nothing.here");
  assert.equal(trace[0].caller, "panel");
  assert.deepEqual(trace[0].args, ["a"]);
  assert.equal(trace[0].depth, 0);
  // No runner ever ran, so there is nothing to measure — the line is stamped
  // with the sentinel 0, not a leftover from a clock that never started.
  assert.equal(trace[0].ms, 0);
  // Compared against a freshly constructed instance's own `.message`, not a
  // literal — that way it dies for `""`, for `error.name`
  // ("nothing.here" is not the message), and for `String(error)` (which
  // prepends "CommandNotFound: "), without the test needing an update if the
  // wording of the message itself ever changes.
  assert.equal(trace[0].error, new CommandNotFound("nothing.here").message);
});

test("depth on a not-found trace line reflects how deep the miss happened, not a constant", async () => {
  const { runner } = table({ a: ({ run }) => run("khong-co") });
  const bus = new (Commander({ runner, logger: quiet }))();
  bus.declare({ name: "a", operation: {} });

  await assert.rejects(() => bus.run("a", {}, "root"), CommandNotFound);
  const trace = bus.traceLog();

  assert.equal(trace.length, 2);
  const missing = trace.find((entry) => entry.command === "khong-co");
  assert.equal(missing.depth, 1);
});

test("a command may call another; a cycle is caught with the whole chain", async () => {
  const { runner } = table({
    a: ({ run }) => run("b"),
    b: ({ run }) => run("c"),
    c: () => "done",
    loop: ({ run }) => run("back"),
    back: ({ run }) => run("loop"),
  });
  const bus = new (Commander({ runner, logger: quiet }))();
  for (const name of ["a", "b", "c", "loop", "back"]) bus.declare({ name, operation: {} });

  assert.equal(await bus.run("a", {}, "root"), "done");

  await assert.rejects(
    () => bus.run("loop", {}, "root"),
    (error) => error instanceof CommandCycle && error.chain.join(" → ") === "loop → back → loop",
  );
});

test("the trace records argument names, never their values", async () => {
  const { runner } = table({ a: ({ run }) => run("b"), b: () => [1, 2, 3] });
  const bus = new (Commander({ runner, logger: quiet }))();
  bus.declare({ name: "a", operation: {} });
  bus.declare({ name: "b", operation: {} });

  await bus.run("a", { password: "hunter2", email: "someone@example.com" }, "panel");
  const trace = bus.traceLog();

  assert.deepEqual(
    trace.map((entry) => ({ command: entry.command, caller: entry.caller, args: entry.args, ok: entry.ok, depth: entry.depth })),
    [
      { command: "b", caller: "a", args: [], ok: true, depth: 1 },
      { command: "a", caller: "panel", args: ["password", "email"], ok: true, depth: 0 },
    ],
  );
  assert.equal(trace.find((entry) => entry.command === "b").rows, 3);
  assert.ok(trace.every((entry) => typeof entry.ms === "number"));
  assert.equal(JSON.stringify(trace).includes("hunter2"), false, "no value ever reaches the trace");
});

test("a failed run is traced with its error", async () => {
  const bus = new (Commander({
    runner: async () => {
      throw new Error("index missing");
    },
    logger: quiet,
  }))();
  bus.declare({ name: "a", operation: {} });

  await assert.rejects(() => bus.run("a", {}, "panel"));
  assert.deepEqual(bus.traceLog().map((e) => [e.command, e.ok, e.error]), [["a", false, "index missing"]]);
});

test("two runs of the same command in flight are not mistaken for a cycle", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let started = 0;

  const { runner } = table({
    slow: async ({ run }) => {
      started++;
      await gate;
      return run("leaf");
    },
    leaf: () => "leaf",
  });
  const bus = new (Commander({ runner, logger: quiet }))();
  for (const name of ["slow", "leaf"]) bus.declare({ name, operation: {} });

  // The same name, twice, overlapping: with one shared stack this reads as slow → slow.
  const first = bus.run("slow", {}, "one");
  const second = bus.run("slow", {}, "two");
  assert.equal(started, 2);

  release();
  assert.deepEqual(await Promise.all([first, second]), ["leaf", "leaf"]);
});

test("a scope binds the caller and the owner, and cannot claim another's", async () => {
  const { runner, calls } = table({ "orders.list": [] });
  const bus = new (Commander({ runner, logger: quiet }))();

  const orders = bus.scope("orders");
  orders.declare(listOrders);
  await orders.run("orders.list");

  assert.equal(calls[0].caller, "orders");
  assert.deepEqual(bus.namesOwnedBy("orders"), ["orders.list"]);
  assert.equal(await orders.tryRun("missing", {}, "fallback"), "fallback");
  assert.throws(() => bus.scope(""), TypeError);
});

test("storageKey shares the registry across two Commander() calls", async () => {
  const key = `commander-${Math.random().toString(36).slice(2)}`;
  const { runner } = table({ "orders.list": ["shared"] });

  new (Commander({ runner, logger: quiet, storageKey: key }))().declare(listOrders);
  const other = new (Commander({ runner, logger: quiet, storageKey: key }))();

  assert.equal(other.has("orders.list"), true);
  assert.deepEqual(await other.run("orders.list"), ["shared"]);
  assert.equal(new (Commander({ runner, logger: quiet }))().has("orders.list"), false);
});

test("a bus needs a runner", () => {
  assert.throws(() => Commander({}), TypeError);
});
