/**
 * The driver against a real server, over a real socket.
 *
 * Everything else in this suite tests one side of a contract. This is the only
 * test that checks the two sides agree, and it is the one that found the bugs:
 * field names that differed, a failure payload the driver could not read, a
 * mode the server had never implemented, and a signing label where a blank
 * configuration field silently chose an incompatible key. Every one of those
 * passed every unit test on both sides, because each side agreed with itself.
 *
 * It needs the Go binaries, so it skips without them:
 *
 *   SAPEDB_SERVER_BIN=/path/to/sapedbd SAPEDB_CLI_BIN=/path/to/sapedb node --test tests/server.test.mjs
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

import { Client } from "../dist/client/index.mjs";
import { nodeTransport } from "../dist/node/index.mjs";
import { sign } from "../dist/signer/index.mjs";
import { Refused } from "../dist/errors.mjs";

const SERVER = process.env.SAPEDB_SERVER_BIN;
const CLI = process.env.SAPEDB_CLI_BIN;
const SECRET = "a-secret-for-this-test-only";
const PASSWORD = "a-password-of-the-right-shape";

const skip = SERVER && CLI ? false : "set SAPEDB_SERVER_BIN and SAPEDB_CLI_BIN to run this";

const schema = {
  collections: [
    {
      name: "notes",
      key: { path: "id", type: "string", auto: "ulid" },
      indexes: [{ name: "by_topic", fields: [{ path: "topic", type: "string", missing: "skip" }] }],
    },
  ],
  operations: [
    {
      name: "notes.add",
      collection: "notes",
      action: "insert",
      input: [
        { name: "body", type: "string", required: true },
        { name: "topic", type: "string", required: true },
      ],
      document: { body: { arg: "body" }, topic: { arg: "topic" } },
    },
    {
      name: "notes.by_topic",
      collection: "notes",
      action: "scan",
      index: "by_topic",
      limit: 10,
      input: [{ name: "topic", type: "string", required: true }],
      from: { terms: [{ arg: "topic" }] },
      to: { terms: [{ arg: "topic" }] },
    },
  ],
};

let server;
let url;

/** A port the operating system just gave back, so two runs do not collide. */
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

before(async () => {
  if (skip) return;

  const dir = mkdtempSync(join(tmpdir(), "sapedb-contract-"));
  const env = { ...process.env, SAPEDB_SECRET: SECRET, SAPEDB_DIR: dir, SAPEDB_ACCOUNT: "acme", SAPEDB_DB: "main" };

  /* Declared before the server starts: it holds the directory for its whole
     life, so the tool and the server never write the same file at once. */
  writeFileSync(join(dir, "schema.json"), JSON.stringify(schema));
  execFileSync(CLI, ["apply", join(dir, "schema.json")], { env });

  const port = await freePort();
  server = spawn(SERVER, [], {
    env: { ...env, SAPEDB_INSECURE: "1", SAPEDB_ADDR: `127.0.0.1:${port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the server did not announce itself")), 5000);
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("error", reject);
  });

  const sig = await sign({ accountId: "acme", password: PASSWORD, dbname: "main" }, { secret: SECRET });
  url = `sapedb://acme:${PASSWORD}@127.0.0.1:${port}/main?sig=${sig}`;
});

after(() => {
  server?.kill("SIGTERM");
});

/* Both modes, because they take different paths through the server: bound
   verifies once at the handshake, account verifies every call. A driver
   configured either way has to work against the same server. */
for (const mode of ["bound", "account"]) {
  test(`${mode}: a call goes out and an answer comes back`, { skip }, async () => {
    const Made = Client({ transport: nodeTransport({ insecure: true }), mode, requestTimeout: 5000 });
    const client = new Made();

    try {
      const roundTrip = await client.ping(url);
      assert.ok(roundTrip >= 0, "ping did not come back");

      const written = await client.invoke(
        url,
        "notes.add",
        { body: `written in ${mode}`, topic: mode },
        { write: true },
      );
      assert.equal(written.changed, 1);
      assert.equal(typeof written.key, "string");

      const read = await client.invoke(url, "notes.by_topic", { topic: mode });
      assert.equal(read.count, 1);
      assert.equal(read.rows[0].body, `written in ${mode}`);
    } finally {
      await client.close();
    }
  });

  test(`${mode}: a failure arrives as one the driver can act on`, { skip }, async () => {
    const Made = Client({ transport: nodeTransport({ insecure: true }), mode, requestTimeout: 5000 });
    const client = new Made();

    try {
      /* A code, not prose. Telling failures apart by matching strings is how a
         driver breaks the day a server improves its wording. */
      await assert.rejects(
        () => client.invoke(url, "notes.nothing", {}),
        (error) => {
          assert.equal(error.code, "no_operation");
          return true;
        },
      );

      await assert.rejects(
        () => client.invoke(url, "notes.add", { body: "no topic" }, { write: true }),
        (error) => {
          assert.equal(error.code, "argument");
          return true;
        },
      );
    } finally {
      await client.close();
    }
  });
}

test("a connection string nobody signed for is refused", { skip }, async () => {
  const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
  const client = new Made();

  try {
    const forged = url.replace(/sig=[0-9a-f]+/, `sig=${"ab".repeat(32)}`);
    /* Task 0048: this used to arrive as a bare Unavailable("the store closed
       the connection") — true, but not why. The real server here answers
       with a Failure at handshake time, and the driver now remembers it: the
       error the caller sees carries the server's own code. That code reads
       "handshake", not "signature" — codeFor() on the Go side matches
       ErrHandshake before it ever gets a chance to see signing.ErrBadSignature,
       because handshake() wraps the bad-signature error with "%w: %v" against
       ErrHandshake, which drops the original error out of the errors.Is()
       chain entirely (measured in internal/server/server_test.go on the Go
       side; codeFor()/handshake() are out of scope for 0048 either way). */
    await assert.rejects(
      () => client.invoke(forged, "notes.by_topic", { topic: "bound" }),
      (error) => {
        assert.ok(error instanceof Refused, `want Refused, got ${error.constructor.name}: ${error.message}`);
        assert.equal(error.code, "handshake");
        return true;
      },
    );
  } finally {
    await client.close();
  }
});

test("the same write id twice writes once", { skip }, async () => {
  const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
  const client = new Made();

  try {
    const writeId = `01TESTWRITEID${Date.now().toString(36).toUpperCase()}`.slice(0, 26).padEnd(26, "0");

    const first = await client.invoke(url, "notes.add", { body: "once", topic: "retry" }, { writeId });
    const second = await client.invoke(url, "notes.add", { body: "once", topic: "retry" }, { writeId });

    assert.equal(second.key, first.key, "the retry made a second document");

    const read = await client.invoke(url, "notes.by_topic", { topic: "retry" });
    assert.equal(read.count, 1, "the retry is in the store twice");
  } finally {
    await client.close();
  }
});

test("a subscription catches up and then keeps up", { skip }, async () => {
  const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
  const client = new Made();

  try {
    const seen = [];
    const ended = [];

    const feed = await client.subscribe(url, { from: 1, onEnd: (reason) => ended.push(reason) }, (change) =>
      seen.push(change),
    );

    assert.equal(feed.from, 1);
    assert.ok(feed.latest >= 1, "the store reported no entries");

    /* The catch-up: everything already in the log, in order, with nothing
       invented and nothing skipped. */
    await waitFor(() => seen.length >= feed.latest, "the catch-up never finished");
    for (let i = 0; i < feed.latest; i++) {
      assert.equal(seen[i].lsn, i + 1, `entry ${i + 1} arrived as ${seen[i].lsn}`);
    }

    // And then what happens next, without asking again.
    const written = await client.invoke(url, "notes.add", { body: "live", topic: "feed" }, { write: true });
    await waitFor(() => seen.some((c) => c.key === written.key), "the live change never arrived");

    const live = seen.find((c) => c.key === written.key);
    assert.equal(live.kind, "put");
    assert.equal(live.document.body, "live");
    /* Who did it, and under which declared operation — the audit trail is the
       same log, not a second one that can disagree with it. */
    assert.equal(live.by.operation, "notes.add");

    feed.close();
    assert.deepEqual(ended, [], "the feed ended on its own");
  } finally {
    await client.close();
  }
});

test("a subscription is told when the connection goes", { skip }, async () => {
  const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
  const client = new Made();

  const ended = [];
  await client.subscribe(url, { from: 1, onEnd: (reason) => ended.push(reason) }, () => {});

  /* Closing the client takes the connection with it. A feed left silent would
     have somebody waiting for changes that will never come, on a database
     busily making them. */
  await client.close();
  await waitFor(() => ended.length > 0, "the feed was not told the connection had gone");
});

test("explore is refused before elevate, and answers get/scan/count/catalogue after", { skip }, async () => {
  const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
  const client = new Made();

  try {
    /* The read/probe channel is not open by default — proving something
       operates the server is a separate step from proving a connection
       string, and nothing here should let one stand in for the other. */
    await assert.rejects(
      () => client.explore(url, { access: { kind: "count", collection: "notes" } }),
      (error) => {
        assert.ok(error instanceof Refused, `want Refused, got ${error.constructor.name}: ${error.message}`);
        assert.equal(error.code, "not_operator");
        return true;
      },
    );

    const written = await client.invoke(url, "notes.add", { body: "explored", topic: "explore-test" }, { write: true });

    const elevated = await client.elevate(url, SECRET);
    assert.equal(elevated.operator, true);

    const got = await client.explore(url, { access: { kind: "get", collection: "notes", key: written.key } });
    assert.equal(got.result.rows[0].body, "explored");
    /* Explore blanks these on purpose: they name a declared operation and its
       version, and a draft is neither. */
    assert.equal(got.result.operation, "");
    assert.equal(got.result.version, 0);
    assert.equal(got.draft.name, "notes.get");
    assert.equal(got.draft.collection, "notes");
    assert.equal(got.draft.action, "get");

    /* This side sends `values`/`exclusive`, lower-case, for a Bound — the one
       type in the whole exchange with no `json` tag on the Go side at all
       (`Values`/`Exclusive`, capitalized). If `encoding/json`'s
       case-insensitive fallback did not apply here, this scan would come
       back unbounded or empty instead of the one row it asks for. */
    const scanned = await client.explore(url, {
      access: {
        kind: "scan",
        collection: "notes",
        index: "by_topic",
        from: { values: ["explore-test"] },
        to: { values: ["explore-test"] },
        limit: 10,
      },
    });
    assert.equal(scanned.result.count, 1);
    assert.equal(scanned.result.rows[0].topic, "explore-test");

    const counted = await client.explore(url, {
      access: {
        kind: "count",
        collection: "notes",
        index: "by_topic",
        from: { values: ["explore-test"] },
        to: { values: ["explore-test"] },
      },
    });
    assert.equal(counted.result.count, 1);

    const catalogue = await client.explore(url, { catalogue: true });
    assert.ok(catalogue.here.collections.some((c) => c.name === "notes"), "the declared collection is missing from the catalogue");
    assert.ok(catalogue.here.operations.some((o) => o.name === "notes.add"), "a declared operation is missing from the catalogue");
    assert.ok(catalogue.here.operations.some((o) => o.name === "notes.by_topic"));
  } finally {
    await client.close();
  }
});

test("catalogue on a database with nothing declared yet answers collections: null, not []", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapedb-empty-"));
  const port = await freePort();
  const secret = "another-secret-for-the-empty-db-test";

  const proc = spawn(SERVER, [], {
    env: { ...process.env, SAPEDB_SECRET: secret, SAPEDB_DIR: dir, SAPEDB_INSECURE: "1", SAPEDB_ADDR: `127.0.0.1:${port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
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

    /* Nothing runs `apply` here — the database is opened, and its catalogue
       asked for, before a single collection has ever been declared. */
    const password = "another-password-of-the-right-shape";
    const sig = await sign({ accountId: "acme", password, dbname: "fresh" }, { secret });
    const freshUrl = `sapedb://acme:${password}@127.0.0.1:${port}/fresh?sig=${sig}`;

    const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
    const client = new Made();
    try {
      await client.elevate(freshUrl, secret);
      const explored = await client.explore(freshUrl, { catalogue: true });

      /* store.Catalogue.Collections carries no `omitempty`, and the loop that
         fills it in only ever appends — starting from a `nil` slice, on a
         database that has never had anything declared, it stays `nil`, and a
         `nil` slice with no `omitempty` marshals as JSON `null`. A caller
         that assumed `[]` here and reached straight for `.map` would break
         on exactly the database that most needs this read to work. */
      assert.equal(explored.here.collections, null, "a database with nothing declared yet should answer null, not []");
      assert.deepEqual(explored.here.operations, []);
    } finally {
      await client.close();
    }
  } finally {
    proc.kill("SIGTERM");
  }
});

/** waitFor polls a condition, so a test that is wrong fails instead of hanging. */
async function waitFor(condition, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}
