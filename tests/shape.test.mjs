/* Against the built package in dist/, the thing that ships. */
import { test } from "node:test";
import assert from "node:assert/strict";

const { ShapeRegistry } = await import(new URL("../dist/shape/index.mjs", import.meta.url).href);

const quiet = { warn() {} };
const recorder = () => {
  const lines = [];
  return { lines, warn: (...args) => lines.push(args.join(" ")) };
};

const orders = {
  label: "Orders",
  group: "Commerce",
  widget: "table",
  commands: { list: "orders.list", count: "orders.count" },
};

test("a shape is what a panel iterates, and it names commands by role", () => {
  const shapes = new (ShapeRegistry({ logger: quiet }))();
  shapes.scope("orders").declare("collection", "orders", orders);
  shapes.scope("billing").declare("collection", "invoices", { label: "Invoices", commands: { list: "billing.invoices" } });

  const listed = shapes.of("collection");
  assert.deepEqual(
    listed.map((shape) => [shape.kind, shape.key, shape.owner, shape.commands.list]),
    [
      ["collection", "orders", "orders", "orders.list"],
      ["collection", "invoices", "billing", "billing.invoices"],
    ],
  );

  // A panel written for the kind knows the roles, never the real names.
  assert.deepEqual(
    listed.map((shape) => shape.commands.list),
    ["orders.list", "billing.invoices"],
  );
});

test("owner is attributed, not claimed", () => {
  const shapes = new (ShapeRegistry({ logger: quiet }))();
  shapes.scope("orders").declare("collection", "orders", { ...orders, owner: "billing", key: "invoices" });

  const shape = shapes.get("collection", "orders");
  assert.equal(shape.owner, "orders");
  assert.equal(shape.key, "orders");
});

test("a shape must be data: no function, no class instance", () => {
  const shapes = new (ShapeRegistry({ logger: quiet }))();

  assert.throws(() => shapes.declare("collection", "orders", { render: () => null }), TypeError);
  assert.throws(() => shapes.declare("collection", "orders", { at: new Date() }), TypeError);
  assert.throws(() => shapes.declare("", "orders", {}), TypeError);
  assert.throws(() => shapes.declare("collection", "", {}), TypeError);
});

test("what was declared cannot be changed afterwards", () => {
  const shapes = new (ShapeRegistry({ logger: quiet }))();
  const declaration = { label: "Orders", commands: { list: "orders.list" } };
  shapes.declare("collection", "orders", declaration);

  declaration.label = "Changed";
  declaration.commands.list = "somewhere.else";

  const shape = shapes.get("collection", "orders");
  assert.equal(shape.label, "Orders");
  assert.equal(shape.commands.list, "orders.list");
  assert.throws(() => {
    shape.label = "Changed";
  }, TypeError);
});

test("replacing another publisher's shape is allowed, but never silent", () => {
  const logger = recorder();
  const shapes = new (ShapeRegistry({ logger }))();

  shapes.scope("orders").declare("collection", "orders", orders);
  shapes.scope("orders").declare("collection", "orders", { ...orders, label: "Orders v2" });
  assert.equal(logger.lines.length, 0, "the same publisher replacing its own says nothing");

  shapes.scope("reports").declare("collection", "orders", { label: "Someone else's" });
  assert.equal(shapes.get("collection", "orders").owner, "reports");
  assert.equal(logger.lines.filter((line) => line.includes("replaced shape collection/orders")).length, 1);
});

test("kinds: open by default, closed when the registry is given a list", () => {
  const open = new (ShapeRegistry({ logger: quiet }))();
  open.declare("anything-at-all", "x", {});
  assert.deepEqual(open.kinds(), ["anything-at-all"]);

  const closed = new (ShapeRegistry({ kinds: ["collection", "metric"], logger: quiet }))();
  closed.declare("collection", "orders", orders);
  assert.throws(() => closed.declare("widget", "x", {}), /unknown shape kind "widget"/);
});

test("reading: of, get, has, ofOwner, kinds", () => {
  const shapes = new (ShapeRegistry({ logger: quiet }))();
  const owner = shapes.scope("orders");
  owner.declare("collection", "orders", orders);
  owner.declare("metric", "orders.revenue", { label: "Revenue", commands: { value: "orders.revenue" } });
  shapes.scope("billing").declare("metric", "billing.mrr", { label: "MRR" });

  assert.deepEqual(shapes.kinds(), ["collection", "metric"]);
  assert.equal(shapes.has("collection", "orders"), true);
  assert.equal(shapes.has("collection", "nothing"), false);
  assert.equal(shapes.get("collection", "nothing"), undefined);
  assert.deepEqual(shapes.of("nothing-declared"), []);

  assert.deepEqual(
    shapes.ofOwner("orders").map((shape) => `${shape.kind}/${shape.key}`),
    ["collection/orders", "metric/orders.revenue"],
  );
  assert.deepEqual(owner.of("metric").length, 2, "a scope reads everything, it only writes as itself");
});

test("storageKey shares the registry across two ShapeRegistry() calls", () => {
  const key = `shape-${Math.random().toString(36).slice(2)}`;
  new (ShapeRegistry({ logger: quiet, storageKey: key }))().declare("collection", "orders", orders);

  assert.equal(new (ShapeRegistry({ logger: quiet, storageKey: key }))().has("collection", "orders"), true);
  assert.equal(new (ShapeRegistry({ logger: quiet }))().has("collection", "orders"), false);
});
