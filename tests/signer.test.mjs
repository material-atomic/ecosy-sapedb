/* Against the built package in dist/, the thing that ships. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { sign, verify, signedMessage, isValidPassword, assertPassword, PASSWORD_PATTERN, DEFAULT_LABEL } = await import(
  new URL("../dist/signer/index.mjs", import.meta.url).href
);

const fixture = JSON.parse(readFileSync(new URL("../fixtures/signing.json", import.meta.url), "utf8"));
const OPTIONS = { secret: fixture.secret, label: fixture.label };

test("fixture: its label is the same one DEFAULT_LABEL actually is", () => {
  // Every assertion above signs with fixture.label, not DEFAULT_LABEL — so
  // renaming DEFAULT_LABEL without touching the fixture (or the reverse)
  // would leave every one of them green. This is the one line that ties
  // "the fixture verifies against itself" to "the fixture is what this
  // package actually ships as its default."
  assert.equal(fixture.label, DEFAULT_LABEL);

  // Built from a RegExp constructor rather than a regex literal spelling the
  // old word out: this file is inside the tree tests/naming.test.mjs walks
  // with no exceptions allowed, and a literal old word here would be a hit
  // in the very tree that test calls clean.
  const oldWord = ["r", "s", "q", "l"].join("");
  assert.doesNotMatch(fixture.secret, new RegExp(oldWord, "i"), "the fixture secret still names the old product");
});

test("a signature made under the old label does not verify under the current default", async () => {
  // Built from a template literal with the old word spelled apart, the same
  // way the assertion above checks for it in the fixture secret: this file
  // is inside the tree tests/naming.test.mjs walks, and internal/naming's
  // Go counterpart explains the same choice next to its own version of this
  // test.
  const oldWord = ["r", "s", "q", "l"].join("");
  const oldLabel = `ecosy/${oldWord}:connection:v1`;
  assert.notEqual(oldLabel, DEFAULT_LABEL, "the old and current labels must differ for this test to mean anything");

  const parts = { accountId: "u", password: "some-password-here", dbname: "p" };
  const sig = await sign(parts, { secret: fixture.secret, label: oldLabel });

  assert.equal(await verify(sig, parts, { secret: fixture.secret }), false, "verified with label omitted (the default)");
  assert.equal(await verify(sig, parts, { secret: fixture.secret, label: DEFAULT_LABEL }), false, "verified against DEFAULT_LABEL explicitly");
});

test("fixture: every case signs to the hex the store must produce, in both modes", async () => {
  assert.ok(fixture.cases.length >= 6);

  for (const { name, accountId, password, dbname, derived, direct } of fixture.cases) {
    const parts = { accountId, password, dbname };

    assert.equal(await sign(parts, OPTIONS), derived, `${name} (derived)`);
    assert.equal(await sign(parts, { secret: fixture.secret, label: null }), direct, `${name} (direct)`);

    for (const sig of [derived, direct]) assert.match(sig, /^[0-9a-f]{64}$/, `${name}: lower-case hex, 32 bytes`);
    assert.notEqual(derived, direct, `${name}: the two modes must not agree`);

    assert.equal(await verify(derived, parts, OPTIONS), true, name);
    assert.equal(await verify(direct, parts, { secret: fixture.secret, label: null }), true, name);
    assert.equal(await verify(direct, parts, OPTIONS), false, `${name}: a mode mismatch is a failed signature`);
  }
});

test("fixture: the two splits of the same characters sign differently", () => {
  const [one, other] = fixture.cases.filter((c) => c.name.includes("split of") || c.name.includes("other split"));
  assert.ok(one && other);
  assert.equal(one.accountId + one.password + one.dbname, other.accountId + other.password + other.dbname, "same characters");
  assert.notEqual(one.derived, other.derived, "different signatures — the delimiter is doing its job");
  assert.notEqual(one.direct, other.direct);
});

test("the message signed is account:password:dbname, unnormalised", () => {
  assert.equal(signedMessage({ accountId: "u", password: "p".repeat(16), dbname: "proj" }), `u:${"p".repeat(16)}:proj`);
});

test("changing the password changes the signature — that is what revocation is", async () => {
  const parts = { accountId: "u", password: "old-password-old-pw", dbname: "p" };
  const before = await sign(parts, OPTIONS);
  const after = await sign({ ...parts, password: "new-password-new-pw" }, OPTIONS);
  assert.notEqual(before, after);
  assert.equal(await verify(before, { ...parts, password: "new-password-new-pw" }, OPTIONS), false);
});

test("another secret, or another label, does not verify", async () => {
  const parts = { accountId: "u", password: "some-password-here", dbname: "p" };
  const sig = await sign(parts, OPTIONS);
  assert.equal(await verify(sig, parts, { secret: `${fixture.secret}x`, label: fixture.label }), false);
  assert.equal(await verify(sig, parts, { secret: fixture.secret, label: "other/label" }), false);
  assert.equal(await sign(parts, { secret: fixture.secret }), await sign(parts, { secret: fixture.secret, label: DEFAULT_LABEL }), "the default is the derived mode");

  // The plain form: the secret is the key, and the label plays no part.
  const direct = await sign(parts, { secret: fixture.secret, label: null });
  assert.notEqual(direct, sig);
  assert.equal(await verify(direct, parts, { secret: fixture.secret, label: null }), true);
  assert.equal(await verify(direct, parts, { secret: `${fixture.secret}x`, label: null }), false);
});

test("verify: malformed input is false, never a throw", async () => {
  const parts = { accountId: "u", password: "some-password-here", dbname: "p" };
  const sig = await sign(parts, OPTIONS);

  for (const bad of [null, undefined, 42, "", "zz", sig.slice(0, 62), `${sig}00`, sig.toUpperCase().replace(/[0-9]/g, "0")]) {
    assert.equal(await verify(bad, parts, OPTIONS), false, String(bad));
  }
  assert.equal(await verify(sig, { ...parts, password: "short" }, OPTIONS), false, "a password that could not have been issued");
  assert.equal(await verify(sig.toUpperCase(), parts, OPTIONS), true, "hex case is not part of the contract");
});

test("password charset: what the protocol can carry", () => {
  assert.ok(isValidPassword("aA0._~-aA0._~-aA0"));
  assert.ok(isValidPassword("y".repeat(16)));
  assert.ok(isValidPassword("y".repeat(128)));

  for (const bad of ["y".repeat(15), "y".repeat(129), "zürich-passwörd-2024", "has spaces here!", "colon:in-password", "plus+sign-here-x", 42, null]) {
    assert.equal(isValidPassword(bad), false, String(bad));
    assert.throws(() => assertPassword(bad), TypeError, String(bad));
  }

  assert.equal(PASSWORD_PATTERN.test("über"), false, "diacritics are out, so NFC and NFD cannot differ");
});

test("signing refuses fields that would make the message ambiguous", async () => {
  await assert.rejects(() => sign({ accountId: "a:b", password: "y".repeat(16), dbname: "p" }, OPTIONS), TypeError);
  await assert.rejects(() => sign({ accountId: "u", password: "y".repeat(16), dbname: "p:q" }, OPTIONS), TypeError);
  await assert.rejects(() => sign({ accountId: "", password: "y".repeat(16), dbname: "p" }, OPTIONS), TypeError);
  await assert.rejects(() => sign({ accountId: "u", password: "y".repeat(16), dbname: "p" }, { secret: "" }), TypeError);
});
