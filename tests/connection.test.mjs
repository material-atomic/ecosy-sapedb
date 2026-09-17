/* Against the built package in dist/, the thing that ships. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { parseConnectionString, formatConnectionString, verifyConnectionString, redact, DEFAULT_PORT } = await import(
  new URL("../dist/connection/index.mjs", import.meta.url).href
);
const { sign } = await import(new URL("../dist/signer/index.mjs", import.meta.url).href);
const { InvalidConnectionString } = await import(new URL("../dist/errors.mjs", import.meta.url).href);

const fixture = JSON.parse(readFileSync(new URL("../fixtures/signing.json", import.meta.url), "utf8"));
const OPTIONS = { secret: fixture.secret, label: fixture.label };
const [first] = fixture.cases;

const stringFor = (parts, sig) =>
  `rsql://${parts.accountId}:${parts.password}@store.example.com:7433/${parts.dbname}?sig=${sig}`;

test("a string comes apart into the fields a signature covers, plus where to go", () => {
  const target = parseConnectionString(stringFor(first, first.derived));

  assert.deepEqual(target, {
    accountId: first.accountId,
    password: first.password,
    host: "store.example.com",
    port: 7433,
    dbname: first.dbname,
    sig: first.derived,
  });
});

test("the port has a default, and the path is one database", () => {
  const target = parseConnectionString(`rsql://acc:${"y".repeat(16)}@localhost/main?sig=${"a".repeat(64)}`);
  assert.equal(target.port, DEFAULT_PORT);
  assert.equal(target.host, "localhost");
  assert.equal(target.dbname, "main");

  assert.throws(
    () => parseConnectionString(`rsql://acc:${"y".repeat(16)}@localhost/one/two?sig=${"a".repeat(64)}`),
    (error) => error instanceof InvalidConnectionString && error.field === "dbname",
  );
});

test("parse refuses what the protocol cannot carry, and names the field", () => {
  const ok = "y".repeat(16);
  const sig = "a".repeat(64);

  const cases = [
    ["", undefined],
    ["not-a-url", undefined],
    [`postgres://acc:${ok}@host/db?sig=${sig}`, "scheme"],
    [`rsql://host/db?sig=${sig}`, "account_id"],
    [`rsql://acc@host/db?sig=${sig}`, "password"],
    [`rsql://acc:short@host/db?sig=${sig}`, "password"],
    [`rsql://acc:${"y".repeat(129)}@host/db?sig=${sig}`, "password"],
    [`rsql://acc:m%E1%BA%ADt-khau-du-dai@host/db?sig=${sig}`, "password"],
    [`rsql://acc:${ok}@host:99999/db?sig=${sig}`, "port"],
    [`rsql://acc:${ok}@host/db`, "sig"],
    [`rsql://acc:${ok}@host/db?sig=nothex`, "sig"],
    [`rsql://acc:${ok}@host/db?sig=${"a".repeat(63)}`, "sig"],
    [`rsql://a%3Ab:${ok}@host/db?sig=${sig}`, "account_id"],
    [`rsql://acc:${ok}@host/d%3Ab?sig=${sig}`, "dbname"],
  ];

  for (const [value, field] of cases) {
    assert.throws(
      () => parseConnectionString(value),
      (error) => error instanceof InvalidConnectionString && (field === undefined || error.field === field),
      `${value.slice(0, 40)} → ${field}`,
    );
  }
});

test("format and parse round-trip, and format refuses the same things", () => {
  const target = {
    accountId: "acc-1",
    password: "y".repeat(16),
    host: "store.example.com",
    port: 7433,
    dbname: "main",
    sig: "b".repeat(64),
  };

  assert.deepEqual(parseConnectionString(formatConnectionString(target)), target);

  assert.throws(() => formatConnectionString({ ...target, password: "short" }), InvalidConnectionString);
  assert.throws(() => formatConnectionString({ ...target, sig: "nope" }), InvalidConnectionString);
  assert.throws(() => formatConnectionString({ ...target, dbname: "a:b" }), InvalidConnectionString);
});

test("verify says whether this string was issued under this secret", async () => {
  const valid = stringFor(first, first.derived);
  assert.equal(await verifyConnectionString(valid, OPTIONS), true);
  assert.equal(await verifyConnectionString(parseConnectionString(valid), OPTIONS), true);

  // The store holds no password: a rotated one is simply an unsigned triple.
  const rotated = stringFor({ ...first, password: "rotated-password-xyz" }, first.derived);
  assert.equal(await verifyConnectionString(rotated, OPTIONS), false);

  // Another database, the same signature.
  const moved = stringFor({ ...first, dbname: "someone-elses" }, first.derived);
  assert.equal(await verifyConnectionString(moved, OPTIONS), false);

  // The plain signing mode is a different signature, and must not pass as this one.
  assert.equal(await verifyConnectionString(stringFor(first, first.direct), OPTIONS), false);
  assert.equal(await verifyConnectionString(stringFor(first, first.direct), { secret: fixture.secret, label: null }), true);
});

test("a string built here verifies against the signature it was built with", async () => {
  const parts = { accountId: "acc-2", password: "another-password-ok", dbname: "analytics" };
  const sig = await sign(parts, OPTIONS);
  const value = formatConnectionString({ ...parts, host: "127.0.0.1", port: 7433, sig });

  assert.equal(await verifyConnectionString(value, OPTIONS), true);
});

test("redact leaves out the two things that are the credential", () => {
  const value = stringFor(first, first.derived);
  const shown = redact(value);

  assert.equal(shown, `rsql://${first.accountId}:***@store.example.com:7433/${first.dbname}`);
  assert.equal(shown.includes(first.password), false);
  assert.equal(shown.includes(first.derived), false);
  assert.equal(redact(parseConnectionString(value)), shown);
});
