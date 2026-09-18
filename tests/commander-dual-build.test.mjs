/**
 * Against BOTH published builds at once — `dist/commander/index.mjs` loaded
 * with `import()`, `dist/commander/index.js` loaded with `createRequire` —
 * in the same process.
 *
 * That is a dependency none of the other test files have, or should have:
 * every other file in this directory loads only the ESM build. This file
 * needs the CJS one too, because the property under test — that
 * `CommandNotFound.is()` recognises an error minted by the *other* build —
 * is only observable when two real, independently bundled copies of the
 * class exist side by side in one realm. Two hand-written lookalike classes
 * in a single file would prove that `is()` can tell two classes apart; it
 * would not prove that what `dist/` actually ships has closed the gap, which
 * is the only thing worth proving here. `rollup.config.mjs` emits both on
 * every build (`preserveModules: true`, two configs, one `dist/`), and
 * `package.json`'s `exports` map hands both to the same subpath — so this
 * is the shape a real consumer's dependency tree can end up in, not a
 * contrivance.
 *
 * **Deleting this file turns nothing red, and takes six properties out of
 * anyone's care in silence.** Measured, not assumed: remove it, keep
 * `commander.test.mjs`, rebuild, and six mutations survive with the suite
 * green — fixing one `tryRun` body and leaving the other on `instanceof`
 * (either direction), `CommandUnauthorized.is` reading `CommandCycle`'s brand
 * and the reverse, and dropping the brand of `CommandUnauthorized` or of
 * `CommandCycle`. Nothing else in this repository builds a real ESM × CJS
 * case, so nothing else can notice.
 *
 * **The four mirror tests below stop being knives the day `tryRun` stops
 * swallowing a miss that happens deep inside a declared command's runner**
 * (task 0041). Every combination here is that shape: `outer` is declared, and
 * its runner misses on another bus. Today the two sides differ when the
 * identity check is wrong — crossing throws while staying inside one build
 * returns the fallback — and that difference is what `deepEqual` catches.
 * Once both sides throw, `deepEqual` holds no matter what the check does:
 * measured today by disabling the fallback path in both bodies outright
 * (`if (false) return fallback`), which leaves all nine tests in this file
 * green. Tests 3 and 4 stay sharp through that change, because they ask
 * `is()` directly instead of through `tryRun`. Whoever lands 0041 has to
 * decide what the four mirror tests are still proving rather than read them
 * as passing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esm = await import(new URL("../dist/commander/index.mjs", import.meta.url).href);
const cjs = require(new URL("../dist/commander/index.js", import.meta.url).pathname);

const quiet = { warn() {} };

/**
 * Runs a promise to completion without ever throwing out of this helper, and
 * reduces the outcome to a shape two independent calls can be compared by
 * `assert.deepEqual` regardless of which one actually happened. Deliberately
 * NOT "did it equal the string 'fallback'": the claim this file exists to
 * hold is that the two builds answer *the same way* as each other, not which
 * particular way that is — a later task (see task 0028's "ngoài phạm vi")
 * may narrow what tryRun swallows, and this file should keep meaning the same
 * thing on the day that lands.
 */
async function outcome(promise) {
  try {
    return { threw: false, value: await promise };
  } catch {
    return { threw: true, value: undefined };
  }
}

// 1. The premise, stated as a premise. If two builds are ever merged back
// into one shared class, `esm.CommandNotFound === cjs.CommandNotFound`
// becomes true and every assertion below stops meaning anything — that is a
// reason to come back and look at this file, not to delete it quietly.
test("premise: the ESM and CJS builds mint two distinct CommandNotFound constructors", () => {
  assert.notEqual(
    esm.CommandNotFound,
    cjs.CommandNotFound,
    "if this is ever true, dist/ ships one shared class and this whole file stops meaning anything — look again, do not delete it",
  );
});

// 2. The reason the two builds ever meet in the first place: storageKey
// shares one registry across them (internal/global-state.ts), on purpose.
test("storageKey shares its registry across the ESM and CJS builds — the reason the two builds meet at all", async () => {
  const key = `dual-${Math.random().toString(36).slice(2)}`;
  const runner = async () => ["shared"];

  new (esm.Commander({ runner, logger: quiet, storageKey: key }))().declare({
    name: "orders.list",
    operation: { read: "orders" },
  });
  const cjsBus = new (cjs.Commander({ runner, logger: quiet, storageKey: key }))();

  assert.equal(cjsBus.has("orders.list"), true);
  assert.deepEqual(await cjsBus.run("orders.list"), ["shared"]);
});

// 3. `is` recognises an error minted by the other build; `instanceof` never
// does, in both directions. This is the assertion the brand exists for.
test("CommandNotFound.is() recognises the other build's error; instanceof does not, in either direction", async () => {
  const cjsBus = new (cjs.Commander({ runner: async () => null, logger: quiet }))();
  const esmBus = new (esm.Commander({ runner: async () => null, logger: quiet }))();

  let fromCjs;
  try {
    await cjsBus.run("khong-co");
  } catch (error) {
    fromCjs = error;
  }
  let fromEsm;
  try {
    await esmBus.run("khong-co");
  } catch (error) {
    fromEsm = error;
  }

  assert.equal(esm.CommandNotFound.is(fromCjs), true);
  assert.equal(fromCjs instanceof esm.CommandNotFound, false);

  assert.equal(cjs.CommandNotFound.is(fromEsm), true);
  assert.equal(fromEsm instanceof cjs.CommandNotFound, false);
});

// 4. Not blurred together: each of the three error classes keeps a brand the
// other two do not share, even for real instances minted by the other build.
// The knife for an implementation that used one Symbol.for key for all three.
test("each of the three error classes keeps its own brand apart from the other two, across the ESM/CJS boundary", async () => {
  const notFoundBus = new (cjs.Commander({ runner: async () => null, logger: quiet }))();
  let notFound;
  try {
    await notFoundBus.run("khong-co");
  } catch (error) {
    notFound = error;
  }

  const authBus = new (cjs.Commander({ runner: async () => "never runs", logger: quiet }))();
  authBus.declare({ name: "x", operation: {}, auth: true });
  let unauthorized;
  try {
    await authBus.run("x");
  } catch (error) {
    unauthorized = error;
  }

  const cycleBus = new (cjs.Commander({ runner: ({ run }) => run("y"), logger: quiet }))();
  cycleBus.declare({ name: "y", operation: {} });
  let cycle;
  try {
    await cycleBus.run("y");
  } catch (error) {
    cycle = error;
  }

  const instances = { CommandNotFound: notFound, CommandUnauthorized: unauthorized, CommandCycle: cycle };

  for (const checkerName of Object.keys(instances)) {
    for (const [instanceName, instance] of Object.entries(instances)) {
      assert.equal(
        esm[checkerName].is(instance),
        checkerName === instanceName,
        `esm.${checkerName}.is(a real ${instanceName} minted by the cjs build)`,
      );
    }
  }
});

/**
 * Builds an "outer" command whose runner calls a genuinely missing command
 * ("khong-co") on a wholly separate bus — the "inner" one — rather than
 * calling back into itself. `run` is used, not `request.run`, on purpose:
 * this is meant to model a call reaching across a module boundary into a
 * different Commander entirely, which does not share a call stack or a
 * cycle check with the caller. `mod` is the module (esm or cjs) the outer
 * bus's own class comes from; `innerBus` supplies the runner's failure.
 */
function makeOuter(mod, innerBus, { asScope } = {}) {
  const bus = new (mod.Commander({
    runner: async () => innerBus.run("khong-co"),
    logger: quiet,
  }))();
  bus.declare({ name: "outer", operation: {} });
  return asScope ? bus.scope("caller") : bus;
}

function makeInner(mod) {
  // "khong-co" is never declared on this bus, so calling it is always a miss.
  return new (mod.Commander({ runner: async () => null, logger: quiet }))();
}

async function combo(outerMod, innerMod, asScope) {
  const inner = makeInner(innerMod);
  const target = makeOuter(outerMod, inner, { asScope });
  return outcome(target.tryRun("outer", {}, "FB"));
}

// 5 & 6. The four combinations that actually cross the module boundary, each
// mirrored against the same shape (bus or scope) built entirely within one
// build. Both bus.tryRun and scope().tryRun are exercised, because fixing
// the identity check in one and leaving the other on `instanceof` is exactly
// the failure mode this task exists to close (task 0028 round 1's own bug,
// one level up).
test("ESM outer, CJS inner, through bus.tryRun: crossing the boundary answers the same as staying inside one build", async () => {
  assert.deepEqual(await combo(esm, cjs, false), await combo(esm, esm, false));
});

test("ESM outer, CJS inner, through scope().tryRun: crossing the boundary answers the same as staying inside one build", async () => {
  assert.deepEqual(await combo(esm, cjs, true), await combo(esm, esm, true));
});

test("CJS outer, ESM inner, through bus.tryRun: crossing the boundary answers the same as staying inside one build", async () => {
  assert.deepEqual(await combo(cjs, esm, false), await combo(cjs, cjs, false));
});

test("CJS outer, ESM inner, through scope().tryRun: crossing the boundary answers the same as staying inside one build", async () => {
  assert.deepEqual(await combo(cjs, esm, true), await combo(cjs, cjs, true));
});

// 7. The forward case: a real, successful command still works when the call
// genuinely crosses the ESM/CJS boundary — so this fix cannot be read as
// "anything crossing a build boundary becomes a fallback".
test("a real command still runs correctly when the call crosses the ESM/CJS boundary", async () => {
  const innerCjsBus = new (cjs.Commander({ runner: async () => [1, 2, 3], logger: quiet }))();
  innerCjsBus.declare({ name: "inner.list", operation: {} });

  const outerEsmBus = new (esm.Commander({ runner: async () => innerCjsBus.run("inner.list"), logger: quiet }))();
  outerEsmBus.declare({ name: "outer", operation: {} });

  assert.deepEqual(await outerEsmBus.run("outer"), [1, 2, 3]);
});
