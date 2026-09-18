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
 * **Task 0041 update.** The four mirror tests used to compare "crossing the
 * boundary" against "staying inside one build" with `deepEqual`, on the
 * premise that both sides answered the fallback and only the *identity
 * check* used to reach it could differ. 0041 changes what the right answer
 * IS for that shape (a miss inside a declared command's own runner): both
 * sides now THROW, so `deepEqual` on the outcome holds regardless of
 * whether the check underneath is right — verified by disabling the
 * fallback path outright (`if (false) return fallback`) in the merged
 * `tryExecute` and rebuilding: all nine tests that existed before this task
 * stayed green. A test that stops distinguishing right from wrong is a
 * test that stopped watching, even while it stays green, so the four below
 * were rewritten to pin the concrete outcome (throw, with `.command` naming
 * the command that actually missed) instead of comparing two sides that can
 * no longer disagree. A fifth test below adds back a fallback path this
 * file can still watch: a SHALLOW miss, which never crosses a build
 * boundary by construction (see the comment on that test for why that is
 * not a gap).
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
 * reduces the outcome to a shape `assert.deepEqual` can compare regardless of
 * which one actually happened — a throw and a resolved value are otherwise
 * not comparable at all. Originally used to compare two independent calls
 * against EACH OTHER (crossing a build boundary vs. staying inside one), on
 * the premise that only the identity check underneath could differ and the
 * two sides should always agree either way. Task 0041 removed that premise
 * for a miss deep inside a runner (see the top-of-file comment) — the four
 * tests that used to compare against each other now pin a concrete answer
 * instead. What is left for `outcome()` to help with is the shallow-miss
 * mirror below, which still compares dynamic calls against a fixed expected
 * shape rather than against each other, but still needs "did it throw or
 * return" reduced to something comparable first.
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

// 4b. Task 0041, Đo 1, pinned. `CommandNotFound.is()` already recognised an
// error minted by the other build (test 3 above); the remaining question was
// whether `.command` — the field `tryExecute`'s catch reads to decide what
// actually missed, and the field §5/§6 below pin their assertions on — was
// even present, and correct, across that same boundary. Measured on
// `d51c862` before writing a line of the 0041 fix (terser's `mangle: true`
// does not `mangle.properties`, so a TypeScript parameter property survives
// minification the same way `CommandCycle.chain` already proved for the ESM
// build in `commander.test.mjs`): `typeof` "string", value "khong-co", and
// `is()` true. This test pins exactly that measurement.
test("command crosses the ESM/CJS boundary: a CommandNotFound minted by the CJS build still carries the right `command`, read from the ESM build", async () => {
  const cjsBus = new (cjs.Commander({ runner: async () => null, logger: quiet }))();
  const miss = await cjsBus.run("khong-co").catch((error) => error);

  assert.equal(esm.CommandNotFound.is(miss), true);
  assert.equal(typeof miss.command, "string");
  assert.equal(miss.command, "khong-co");
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

function crossMiss(outerMod, innerMod, asScope) {
  const inner = makeInner(innerMod);
  const target = makeOuter(outerMod, inner, { asScope });
  return target.tryRun("outer", {}, "FB");
}

/**
 * Asserts a `crossMiss(...)` call throws, and that the error is a
 * `CommandNotFound` naming "khong-co" — the command that actually missed,
 * never "outer" (which is declared on every bus involved). `checker` picks
 * which build's `is()` answers the question; since the brand is shared, any
 * build's `is()` recognises either build's instance, so the choice does not
 * change what is being asserted.
 */
function rejectsAsInnerMiss(promise, checker = esm.CommandNotFound) {
  return assert.rejects(() => promise, (error) => checker.is(error) && error.command === "khong-co");
}

/**
 * §5.2, task 0041. The same-name bridging case from `commander.test.mjs`
 * (`error.command === name` reads as "orders.list is missing on A" even
 * though A has it), repeated across the ESM/CJS boundary — the knife for
 * `error.command === name` specifically, in the one shape that also crosses
 * a build boundary. Both directions matter for the same reason
 * bus.tryRun/scope().tryRun both matter above: which build is "outer" and
 * which is "inner" is not symmetric in how the module graph is built.
 *
 * NOT the knife for `Symbol()` → `Symbol.for(...)` on `ROOT_MISS`, despite
 * looking like the obvious candidate — measured, not assumed (see the
 * comment beside `ROOT_MISS` in `src/commander/index.ts`): that swap alone
 * leaves this test green, because the `=== session` comparison already
 * rules out a bridged miss regardless of whether the key reaching it is
 * shared. Left in under its own name for what it does prove, not
 * relabelled to claim a kill it does not make.
 */
test("a facade bus on one build delegating to a backend bus on the OTHER build, under the SAME command name, still throws — not a fallback", async () => {
  const cjsBackend = new (cjs.Commander({ runner: async () => null, logger: quiet }))();
  // cjsBackend never declares "orders.list".
  const esmFacade = new (esm.Commander({ runner: () => cjsBackend.run("orders.list"), logger: quiet }))();
  esmFacade.declare({ name: "orders.list", operation: {} });

  await assert.rejects(
    () => esmFacade.tryRun("orders.list", {}, "FB"),
    (error) => esm.CommandNotFound.is(error) && error.command === "orders.list",
  );

  const esmBackend = new (esm.Commander({ runner: async () => null, logger: quiet }))();
  // esmBackend never declares "orders.list" either.
  const cjsFacade = new (cjs.Commander({ runner: () => esmBackend.run("orders.list"), logger: quiet }))();
  cjsFacade.declare({ name: "orders.list", operation: {} });

  await assert.rejects(
    () => cjsFacade.tryRun("orders.list", {}, "FB"),
    (error) => cjs.CommandNotFound.is(error) && error.command === "orders.list",
  );
});

// 5 & 6, task 0041. §6(a): these four used to be `deepEqual` mirrors of a
// same-build control (see the top-of-file comment for why that stopped
// being a knife). Now each is a pinned assertion — throw, `.command ===
// "khong-co"` — for BOTH the cross-build combination and its same-build
// control, so the two builds are checked against a concrete, shared answer
// rather than against each other. Both bus.tryRun and scope().tryRun are
// exercised, because fixing the identity check in one and leaving the
// other wrong is exactly the failure mode task 0028 round 1 first found,
// one level up, and 0041 could repeat at this level just as easily.
test("ESM outer, CJS inner, through bus.tryRun: a miss inside outer's runner throws, naming the command that actually missed", async () => {
  await rejectsAsInnerMiss(crossMiss(esm, cjs, false));
  await rejectsAsInnerMiss(crossMiss(esm, esm, false)); // same-build control
});

test("ESM outer, CJS inner, through scope().tryRun: a miss inside outer's runner throws, naming the command that actually missed", async () => {
  await rejectsAsInnerMiss(crossMiss(esm, cjs, true));
  await rejectsAsInnerMiss(crossMiss(esm, esm, true)); // same-build control
});

test("CJS outer, ESM inner, through bus.tryRun: a miss inside outer's runner throws, naming the command that actually missed", async () => {
  await rejectsAsInnerMiss(crossMiss(cjs, esm, false), cjs.CommandNotFound);
  await rejectsAsInnerMiss(crossMiss(cjs, cjs, false), cjs.CommandNotFound); // same-build control
});

test("CJS outer, ESM inner, through scope().tryRun: a miss inside outer's runner throws, naming the command that actually missed", async () => {
  await rejectsAsInnerMiss(crossMiss(cjs, esm, true), cjs.CommandNotFound);
  await rejectsAsInnerMiss(crossMiss(cjs, cjs, true), cjs.CommandNotFound); // same-build control
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

/**
 * §6(b), task 0041. The one shape in this file where `tryRun` still answers
 * a fallback: a SHALLOW miss — the command asked for directly is not
 * declared, with nothing in between. Deliberately NOT built to cross the
 * ESM/CJS boundary, and that is not this test settling for less than the
 * rest of the file: after 0041, `ROOT_MISS` is stamped by whichever build's
 * OWN `execute` minted the error, and read back only inside that same
 * build's own `tryExecute` — a root miss is by construction the root of the
 * session that call itself started, and that call always belongs to
 * exactly one build. There is no longer a way to CONSTRUCT a fallback that
 * crosses builds; the four tests above are what proves that (every
 * cross-build shape now throws). So the only fallback path left for this
 * file to watch is a root miss staying inside one build's own bus — which
 * is exactly what `if (false) return fallback` in `tryExecute` would still
 * break, and exactly what four `deepEqual` mirrors below catch: two builds,
 * two entry points, one shared expectation, `outcome()` reducing "returned
 * FB" and "threw" to a shape `deepEqual` can tell apart.
 */
test("a shallow miss (the command asked for is not declared, nothing in between) still answers the fallback, in both builds, through both entry points", async () => {
  const esmBus = new (esm.Commander({ runner: async () => null, logger: quiet }))();
  const cjsBus = new (cjs.Commander({ runner: async () => null, logger: quiet }))();

  const expected = { threw: false, value: "FB" };
  assert.deepEqual(await outcome(esmBus.tryRun("khong-co", {}, "FB")), expected);
  assert.deepEqual(await outcome(cjsBus.tryRun("khong-co", {}, "FB")), expected);
  assert.deepEqual(await outcome(esmBus.scope("s").tryRun("khong-co", {}, "FB")), expected);
  assert.deepEqual(await outcome(cjsBus.scope("s").tryRun("khong-co", {}, "FB")), expected);
});
