/**
 * ISS-20: the same schema, generated twice — once from the file, once from the
 * store that is holding it.
 *
 * The claim this package makes is that a module can publish its shape. Until
 * now it could only do that if somebody also shipped the schema file: a module
 * installed over the wire (`establish` for its collections, `declare` for its
 * operations) lives nowhere on the caller's disk, so its shape had to be
 * copied across by hand. The store already answers `WhatIsHere` with every
 * declaration it holds. This measures whether reading that produces the same
 * declarations the file does.
 *
 * It needs the Go binaries, so it skips without them — the same convention
 * tests/server.test.mjs uses, and the CI job that sets them fails on any skip:
 *
 *   SAPEDB_SERVER_BIN=/path/to/sapedbd SAPEDB_CLI_BIN=/path/to/sapedb node --test tests/types-from-server.test.mjs
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { Client } from "../dist/client/index.mjs";
import { nodeTransport } from "../dist/node/index.mjs";
import { sign } from "../dist/signer/index.mjs";
import { redact } from "../dist/connection/index.mjs";
import { typesFor } from "../dist/types/index.mjs";
import { Refused } from "../dist/errors.mjs";

const SERVER = process.env.SAPEDB_SERVER_BIN;
const CLI = process.env.SAPEDB_CLI_BIN;
const SECRET = "a-secret-for-the-catalogue-test";
const PASSWORD = "a-password-of-the-right-shape";

const skip = SERVER && CLI ? false : "set SAPEDB_SERVER_BIN and SAPEDB_CLI_BIN to run this";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = (path) => fileURLToPath(new URL(path, import.meta.url));
const FIXTURE = "fixtures/ledger.schema.json";
const ledgerSchema = JSON.parse(readFileSync(file(`../${FIXTURE}`), "utf8"));

let server;
let url;

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function announced(proc) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the server did not announce itself")), 5000);
    proc.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.once("error", reject);
  });
}

before(async () => {
  if (skip) return;

  const dir = mkdtempSync(join(tmpdir(), "sapedb-catalogue-"));
  const env = { ...process.env, SAPEDB_SECRET: SECRET, SAPEDB_DIR: dir, SAPEDB_ACCOUNT: "acme", SAPEDB_DB: "main" };

  /* The fixture itself, not a paraphrase of it: the whole comparison below is
     worth nothing if the store is holding a different schema from the one the
     file path reads. Copied rather than applied in place because the daemon
     owns its directory for its whole life. */
  copyFileSync(file(`../${FIXTURE}`), join(dir, "schema.json"));
  execFileSync(CLI, ["apply", join(dir, "schema.json")], { env });

  const port = await freePort();
  server = spawn(SERVER, [], {
    env: { ...env, SAPEDB_INSECURE: "1", SAPEDB_ADDR: `127.0.0.1:${port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await announced(server);

  const sig = await sign({ accountId: "acme", password: PASSWORD, dbname: "main" }, { secret: SECRET });
  url = `sapedb://acme:${PASSWORD}@127.0.0.1:${port}/main?sig=${sig}`;
});

after(() => {
  server?.kill("SIGTERM");
});

/** Runs the shipped bin and hands back what it wrote and what it exited with. */
function cli(args, environment = {}) {
  const run = spawnSync(process.execPath, [file("../bin/sapedb-types.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SAPEDB_SECRET: undefined, ...environment },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** The operation names in the order the generated file declares them. */
function namesIn(source) {
  return [...source.matchAll(/^ {2}"([^"]+)": \{$/gm)].map((found) => found[1]);
}

test("the file path first: it generates the declaration file this repository has committed", { skip }, () => {
  /* The positive control, and it runs before anything is compared to anything.
     A comparison between two paths that are both broken agrees perfectly. */
  const run = cli([FIXTURE]);

  assert.equal(run.status, 0, `the file path failed: ${run.stderr}`);
  assert.equal(run.stdout, readFileSync(file("./typecheck/ledger.d.ts"), "utf8"));
  assert.equal(namesIn(run.stdout).length, ledgerSchema.operations.length, "the fixture and its declaration file disagree about how many operations there are");
});

test("the real store refuses the catalogue to a connection that has not proved the secret", { skip }, async () => {
  const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
  const client = new Made();

  try {
    await assert.rejects(
      () => client.explore(url, { catalogue: true }),
      (error) => {
        assert.ok(error instanceof Refused, `want Refused, got ${error.constructor.name}: ${error.message}`);
        assert.equal(error.code, "not_operator");
        return true;
      },
    );
  } finally {
    await client.close();
  }

  /* And what the bin does with that, both ways round: with no secret to offer
     it never dials, and with the wrong one the store's own refusal is what the
     caller is told. Neither writes a declaration file. */
  const without = cli(["--from", url, "--insecure"]);
  assert.equal(without.status, 1);
  assert.match(without.stderr, /--secret/);
  assert.equal(without.stdout, "");

  const wrong = cli(["--from", url, "--insecure", "--secret", "not-the-server-secret"]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /prove the server secret/);
  assert.equal(wrong.stdout, "");
});

test("the catalogue of a running store generates the same declarations the file does", { skip }, () => {
  const fromFile = cli([FIXTURE]);
  assert.equal(fromFile.status, 0, `the file path failed: ${fromFile.stderr}`);

  const fromServer = cli(["--from", url, "--insecure", "--secret", SECRET]);
  assert.equal(fromServer.status, 0, `the catalogue path failed: ${fromServer.stderr}`);

  const file_ = fromFile.stdout.split("\n");
  const wire = fromServer.stdout.split("\n");

  /* The two are the same length and are not the same file. Line counts are
     exactly the measurement that would have missed this: five operations
     generate five blocks either way. */
  assert.equal(wire.length, file_.length);
  assert.notEqual(fromServer.stdout, fromFile.stdout, "if these are byte-identical the two differences below have gone, and this test is now lying about them");

  /* Difference one, and it is the point of the header: where this file came
     from. The store path names the connection string with the password and the
     signature taken out — a generated file is committed, and is the last place
     a credential should end up. */
  assert.equal(file_[1], ` * Generated by sapedb-types from ${FIXTURE}. Do not edit: regenerate it instead.`);
  assert.equal(wire[1], ` * Generated by sapedb-types from ${redact(url)}. Do not edit: regenerate it instead.`);
  assert.doesNotMatch(fromServer.stdout, /a-password-of-the-right-shape|sig=/, "the connection string's secrets reached the generated file");

  /* Difference two: the order. A file lists its operations in the order
     somebody wrote them; the store keys operations by name, so a catalogue
     arrives name-ordered and carries no memory of how the schema was written.
     Same operations, different sequence — asserted rather than sorted away,
     because a generator that quietly reordered the file path to match would be
     changing the one output that already has users. */
  const fromFileNames = namesIn(fromFile.stdout);
  const fromServerNames = namesIn(fromServer.stdout);

  assert.deepEqual([...fromServerNames].sort(), [...fromFileNames].sort(), "the two sources disagree about which operations exist");
  assert.deepEqual(fromServerNames, [...fromServerNames].sort(), "the catalogue is no longer name-ordered, so the difference below is a different one");
  assert.notDeepEqual(fromServerNames, fromFileNames, "the fixture is now written in name order, so this file no longer measures the reordering it claims to");

  /* And with those two accounted for, every remaining line: the fixture read
     off disk, its operations put in the order the store keeps them, generated
     by the same generator. Line for line, not length against length. */
  const reordered = typesFor(
    { ...ledgerSchema, operations: [...ledgerSchema.operations].sort((a, b) => (a.name < b.name ? -1 : 1)) },
    { source: FIXTURE },
  ).split("\n");

  assert.equal(reordered.length, wire.length);
  for (let at = 0; at < reordered.length; at++) {
    // Line 2 is the header, and it is different on purpose; it is asserted above.
    if (at === 1) continue;
    assert.equal(wire[at], reordered[at], `line ${at + 1} of the catalogue's declaration file is not the file's`);
  }
});

test("a database nobody has declared anything in is refused, and told what would fix it", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapedb-catalogue-empty-"));
  const port = await freePort();
  const secret = "another-secret-for-the-empty-db-test";

  const proc = spawn(SERVER, [], {
    env: { ...process.env, SAPEDB_SECRET: secret, SAPEDB_DIR: dir, SAPEDB_INSECURE: "1", SAPEDB_ADDR: `127.0.0.1:${port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await announced(proc);

    /* Nothing runs `apply` here. An empty database is everybody's first one,
       and "the schema declares no operations" — which is what the generator
       says of a malformed file — is the wrong thing to tell whoever is
       looking at it. */
    const password = "another-password-of-the-right-shape";
    const sig = await sign({ accountId: "acme", password, dbname: "fresh" }, { secret });
    const fresh = `sapedb://acme:${password}@127.0.0.1:${port}/fresh?sig=${sig}`;

    const run = cli(["--from", fresh, "--insecure", "--secret", secret]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no operations declared in it/);
    assert.match(run.stderr, /apply a schema/);
    assert.equal(run.stdout, "");
  } finally {
    proc.kill("SIGTERM");
  }
});
