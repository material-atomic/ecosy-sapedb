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

test("a command that is not declared throws, and tryRun answers instead", async () => {
  const { runner } = table({});
  const bus = new (Commander({ runner, logger: quiet }))();

  await assert.rejects(() => bus.run("nothing.here"), CommandNotFound);
  assert.equal(await bus.tryRun("nothing.here", {}, "fallback"), "fallback");

  bus.declare({ name: "boom", operation: {} });
  const failing = new (Commander({
    runner: async () => {
      throw new Error("the store is down");
    },
    logger: quiet,
  }))();
  failing.declare({ name: "boom", operation: {} });
  assert.equal(await failing.tryRun("boom", {}, "fallback"), "fallback");
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
