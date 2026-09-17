/* Against the built package in dist/, the thing that ships. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { sign, verify, signedMessage, isValidPassword, assertPassword, PASSWORD_PATTERN, DEFAULT_LABEL } = await import(
  new URL("../dist/signer/index.mjs", import.meta.url).href
);

const fixture = JSON.parse(readFileSync(new URL("../fixtures/signing.json", import.meta.url), "utf8"));
const OPTIONS = { secret: fixture.secret, label: fixture.label };

test("fixture: every case signs to the hex the store must produce, in both modes", async () => {
  assert.ok(fixture.cases.length >= 6);

  for (const { name, userId, password, projectId, derived, direct } of fixture.cases) {
    const parts = { userId, password, projectId };

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
  assert.equal(one.userId + one.password + one.projectId, other.userId + other.password + other.projectId, "same characters");
  assert.notEqual(one.derived, other.derived, "different signatures — the delimiter is doing its job");
  assert.notEqual(one.direct, other.direct);
});

test("the message signed is user:password:project, unnormalised", () => {
  assert.equal(signedMessage({ userId: "u", password: "p".repeat(16), projectId: "proj" }), `u:${"p".repeat(16)}:proj`);
});

test("changing the password changes the signature — that is what revocation is", async () => {
  const parts = { userId: "u", password: "old-password-old-pw", projectId: "p" };
  const before = await sign(parts, OPTIONS);
  const after = await sign({ ...parts, password: "new-password-new-pw" }, OPTIONS);
  assert.notEqual(before, after);
  assert.equal(await verify(before, { ...parts, password: "new-password-new-pw" }, OPTIONS), false);
});

test("another secret, or another label, does not verify", async () => {
  const parts = { userId: "u", password: "some-password-here", projectId: "p" };
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
  const parts = { userId: "u", password: "some-password-here", projectId: "p" };
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

  for (const bad of ["y".repeat(15), "y".repeat(129), "mật-khẩu-đủ-dài-rồi", "has spaces here!", "colon:in-password", "plus+sign-here-x", 42, null]) {
    assert.equal(isValidPassword(bad), false, String(bad));
    assert.throws(() => assertPassword(bad), TypeError, String(bad));
  }

  assert.equal(PASSWORD_PATTERN.test("mật"), false, "diacritics are out, so NFC and NFD cannot differ");
});

test("signing refuses fields that would make the message ambiguous", async () => {
  await assert.rejects(() => sign({ userId: "a:b", password: "y".repeat(16), projectId: "p" }, OPTIONS), TypeError);
  await assert.rejects(() => sign({ userId: "u", password: "y".repeat(16), projectId: "p:q" }, OPTIONS), TypeError);
  await assert.rejects(() => sign({ userId: "", password: "y".repeat(16), projectId: "p" }, OPTIONS), TypeError);
  await assert.rejects(() => sign({ userId: "u", password: "y".repeat(16), projectId: "p" }, { secret: "" }), TypeError);
});
