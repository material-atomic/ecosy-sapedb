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
import { createHmac } from "node:crypto";

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
      /* Only for the composed-operation tests below: a rollup, like a
         collection or an index, cannot be declared over the wire, so it has
         to be here before the daemon ever starts. */
      rollups: [{ name: "topic_totals", group: [{ path: "topic", type: "string", missing: "skip" }], count: true }],
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
    /* Task ISS-12: the same read as notes.by_topic, but declaring a scope it
       may not run without. Kept as its own operation, declared alongside the
       plain one in the same schema, so the two can be measured against each
       other with nothing else different between them — same data, same
       action, same index, one gate. */
    {
      name: "notes.by_topic_scoped",
      collection: "notes",
      action: "scan",
      index: "by_topic",
      limit: 10,
      input: [{ name: "topic", type: "string", required: true }],
      from: { terms: [{ arg: "topic" }] },
      to: { terms: [{ arg: "topic" }] },
      scopes: ["notes:scoped_read"],
    },
  ],
};

/**
 * The exact bytes a scope grant signs, and the HMAC that makes them worth
 * something: `account_id ":" dbname ":" scope[,scope...]`, sorted and
 * de-duplicated, under a key derived from the server's secret with the label
 * `sapedb/scopes:v1`. Read from internal/signing/signing.go (GrantLabel,
 * Held, Granting) rather than guessed — this is test-only tooling to prove
 * the wire round trip, not a minting function this package ships: a client
 * cannot hold the server's secret, and this test only can because it is the
 * one side of the suite standing in for whoever issues connection strings.
 */
function mintGrant(secret, accountId, dbname, scopes) {
  const list = [...new Set(scopes)].sort().join(",");
  const message = `${accountId}:${dbname}:${list}`;
  const key = createHmac("sha256", secret).update("sapedb/scopes:v1").digest();
  return createHmac("sha256", key).update(message).digest("hex");
}

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
       That code used to read "handshake": handshake() wrapped the bad
       signature with "%w: %v" against ErrHandshake, which dropped the
       original out of the errors.Is() chain, so codeFor() could only see
       the outer error. The Go side now wraps with "%w: %w", so the cause
       survives and the code names it: "signature". The test was pinning the
       older, less useful answer, and only says so now because it had never
       actually been run -- it sits behind SAPEDB_SERVER_BIN, which CI does
       not set. */
    await assert.rejects(
      () => client.invoke(forged, "notes.by_topic", { topic: "bound" }),
      (error) => {
        assert.ok(error instanceof Refused, `want Refused, got ${error.constructor.name}: ${error.message}`);
        assert.equal(error.code, "signature");
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

/* The positive control for everything below: declare works, end to end, on
   the daemon this file has kept running since the top of the suite. Every
   rejection tested after this one is measured against a path already proven
   to succeed — so a refusal that should not be there cannot be mistaken for
   a driver that was never wired up in the first place. */
test("declare stores an operation on a daemon that is already running: it lands in the catalogue, runs, and the daemon never restarts", { skip }, async () => {
  const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
  const client = new Made();
  const pidBefore = server.pid;

  try {
    await client.elevate(url, SECRET);

    const stored = await client.declare(url, {
      name: "notes.declared_recent",
      collection: "notes",
      action: "scan",
      index: "by_topic",
      input: [{ name: "topic", type: "string", required: true }],
      from: { terms: [{ arg: "topic" }] },
      to: { terms: [{ arg: "topic" }] },
      limit: 10,
      projection: ["topic"],
    });
    assert.equal(stored.name, "notes.declared_recent");
    assert.equal(stored.version, 1, "a first declaration should come back at version 1");

    const catalogue = await client.explore(url, { catalogue: true });
    assert.ok(
      catalogue.here.operations.some((o) => o.name === "notes.declared_recent" && o.version === 1),
      "the operation just declared over the wire is missing from the catalogue",
    );

    await client.invoke(url, "notes.add", { body: "declared live", topic: "declared-recent-test" }, { write: true });

    const read = await client.invoke(url, "notes.declared_recent", { topic: "declared-recent-test" });
    assert.equal(read.count, 1);
    assert.deepEqual(Object.keys(read.rows[0]), ["topic"], "the projection declared over the wire did not take effect");
    assert.equal(read.rows[0].topic, "declared-recent-test");

    // The whole point: this ran on the process the suite started at the top,
    // never stopped and restarted to pick the declaration up.
    assert.equal(server.pid, pidBefore, "the daemon's pid changed — declaring must have restarted it");
    assert.equal(server.exitCode, null, "the daemon exited during the test");
  } finally {
    await client.close();
  }
});

test("declare before elevate is refused the same way explore is, with a fresh connection that never proved the secret", { skip }, async () => {
  const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
  const client = new Made();

  try {
    await assert.rejects(
      () =>
        client.declare(url, {
          name: "notes.should_never_land",
          collection: "notes",
          action: "scan",
          index: "by_topic",
          input: [{ name: "topic", type: "string", required: true }],
          from: { terms: [{ arg: "topic" }] },
          to: { terms: [{ arg: "topic" }] },
          limit: 10,
        }),
      (error) => {
        assert.ok(error instanceof Refused, `want Refused, got ${error.constructor.name}: ${error.message}`);
        assert.equal(error.code, "not_operator");
        return true;
      },
    );

    // The refusal must not have written anything: the catalogue this
    // connection is not even allowed to read is unreachable to check, so ask
    // through a connection that has elevated instead.
    const proof = new Made();
    try {
      await proof.elevate(url, SECRET);
      const catalogue = await proof.explore(url, { catalogue: true });
      assert.ok(
        !catalogue.here.operations.some((o) => o.name === "notes.should_never_land"),
        "a declaration refused for not_operator was written anyway",
      );
    } finally {
      await proof.close();
    }
  } finally {
    await client.close();
  }
});

test("a scan declared with no limit is refused in the store's own words; the identical shape through explore is filled in and accepted", { skip }, async () => {
  const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
  const client = new Made();

  try {
    await client.elevate(url, SECRET);

    await assert.rejects(
      () =>
        client.declare(url, {
          name: "notes.no_limit_scan",
          collection: "notes",
          action: "scan",
          index: "by_topic",
          input: [{ name: "topic", type: "string", required: true }],
          from: { terms: [{ arg: "topic" }] },
          to: { terms: [{ arg: "topic" }] },
          // No `limit` — this is the one field this test is about.
        }),
      (error) => {
        assert.ok(error instanceof Refused, `want Refused, got ${error.constructor.name}: ${error.message}`);
        assert.equal(error.code, "declaration");
        // The store's own words, not a paraphrase this driver made up — see
        // internal/store/ops.go's ErrDeclaration on the server side.
        assert.equal(
          error.message,
          "[ecosy/sapedb] sapedb/store: the declaration does not make sense: a scan must declare how many rows it may return",
        );
        return true;
      },
    );

    /* The asymmetry the task warns about: the same shape, no limit at all,
       reaches store.Explore instead of store.DeclareOperation and comes back
       with rows — because Explore silently fills Limit in before it checks
       anything, and a declaration is a promise about cost nothing here may
       make on a caller's behalf. If this ever throws, the asymmetry closed
       and the comment above (and on declare() in src/client/index.ts) is the
       one that needs rewriting, not this test. */
    const explored = await client.explore(url, {
      access: {
        kind: "scan",
        collection: "notes",
        index: "by_topic",
        from: { values: ["explore-test"] },
        to: { values: ["explore-test"] },
        // No `limit` here either — and this one is accepted.
      },
    });
    assert.ok(explored.result.count >= 1, "the unlimited scan through explore should have been accepted, not refused");
  } finally {
    await client.close();
  }
});

test("invoking an explicit version reaches an older declaration after a redeclare replaces what the name resolves to", { skip }, async () => {
  const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
  const client = new Made();

  try {
    await client.elevate(url, SECRET);

    const first = await client.declare(url, {
      name: "notes.versioned_lookup",
      collection: "notes",
      action: "scan",
      index: "by_topic",
      input: [{ name: "topic", type: "string", required: true }],
      from: { terms: [{ arg: "topic" }] },
      to: { terms: [{ arg: "topic" }] },
      limit: 10,
      projection: ["topic"],
    });
    assert.equal(first.version, 1);

    await client.invoke(url, "notes.add", { body: "under an old declaration", topic: "versioned-lookup-test" }, { write: true });

    const throughV1 = await client.invoke(url, "notes.versioned_lookup", { topic: "versioned-lookup-test" });
    assert.equal(throughV1.count, 1);
    assert.deepEqual(Object.keys(throughV1.rows[0]), ["topic"], "version 1 was declared with a projection of just topic");

    // Redeclaring the same name writes a NEW version and leaves the old one
    // exactly as it was — a second row for the same call, not an overwrite.
    const second = await client.declare(url, {
      name: "notes.versioned_lookup",
      collection: "notes",
      action: "scan",
      index: "by_topic",
      input: [{ name: "topic", type: "string", required: true }],
      from: { terms: [{ arg: "topic" }] },
      to: { terms: [{ arg: "topic" }] },
      limit: 10,
      // No projection this time: the whole document comes back.
    });
    assert.equal(second.version, 2, "redeclaring the same name should mint a new version, not reuse the old one");

    const throughLatest = await client.invoke(url, "notes.versioned_lookup", { topic: "versioned-lookup-test" });
    assert.ok(
      Object.keys(throughLatest.rows[0]).length > 1,
      "the unversioned call should now run version 2, which declared no projection",
    );
    assert.equal(throughLatest.rows[0].topic, "versioned-lookup-test");

    // And the old version is still there to be asked for by name — this is
    // the whole reason InvokeOptions.version exists.
    const throughV1Again = await client.invoke(url, "notes.versioned_lookup", { topic: "versioned-lookup-test" }, { version: 1 });
    assert.deepEqual(
      Object.keys(throughV1Again.rows[0]),
      ["topic"],
      "asking for version 1 explicitly should still run the projected declaration, not the redeclared one",
    );
  } finally {
    await client.close();
  }
});

/* ---- composed operations (task 0070) ----
 *
 * A step of a batch may name an already-declared operation instead of
 * touching a collection, through three fields `Step` gained on the Go side:
 * `operation`, `version` and `with`. Until now this client could neither
 * declare nor read one back — `Step` carried none of the three.
 *
 * The positive control below is what the two refusals after it are measured
 * against: a composed operation declared over the wire, invoked once, and
 * answering rows from both legs it names. A rejection tested without that
 * proof standing first could be a driver that never learned to send the
 * fields at all, dressed up as a validation the store enforces.
 */
test("a composed operation is declared over the wire, invoked once, and answers rows from both legs it names", { skip }, async () => {
  const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
  const client = new Made();

  try {
    await client.elevate(url, SECRET);

    const total = await client.declare(url, {
      name: "notes.total_by_topic",
      collection: "notes",
      action: "totals",
      rollup: "topic_totals",
      input: [{ name: "topic", type: "string", required: true }],
      from: { terms: [{ arg: "topic" }] },
      to: { terms: [{ arg: "topic" }] },
      limit: 1,
    });
    assert.equal(total.version, 1);

    // notes.by_topic was declared through schema.json before the daemon
    // started and has never been redeclared, so it is still version 1 with a
    // ceiling of its own declared limit, 10. This parent declares 11 -- 10
    // plus 1 -- which is exactly the sum, not a margin: see the ceiling test
    // below for what happens one row short of it.
    const composed = await client.declare(url, {
      name: "notes.page_with_total",
      collection: "notes",
      action: "batch",
      limit: 11,
      input: [{ name: "topic", type: "string", required: true }],
      steps: [
        { name: "page", operation: "notes.by_topic", version: 1, with: { topic: { arg: "topic" } } },
        { name: "total", operation: "notes.total_by_topic", version: total.version, with: { topic: { arg: "topic" } } },
      ],
    });
    assert.equal(composed.version, 1);
    // The wire did not quietly drop the composed fields on the way back.
    assert.equal(composed.steps?.length, 2, "the stored declaration lost its steps");
    assert.equal(composed.steps[0].operation, "notes.by_topic");
    assert.equal(composed.steps[0].version, 1);
    assert.equal(composed.steps[1].operation, "notes.total_by_topic");
    assert.equal(composed.steps[1].version, total.version);

    const topic = "composed-page-test";
    for (const body of ["one", "two", "three"]) {
      await client.invoke(url, "notes.add", { body, topic }, { write: true });
    }

    const result = await client.invoke(url, "notes.page_with_total", { topic });
    // Result.Rows is flat and unlabeled -- nothing in it says which step a
    // row came from. 3 notes plus 1 rollup row is known ahead of time only
    // because this test wrote exactly 3 notes under this topic and nothing
    // else did.
    assert.equal(result.rows.length, 4, "3 notes plus 1 rollup row");
    for (const row of result.rows.slice(0, 3)) {
      assert.equal(row.topic, topic);
    }
    assert.equal(result.rows[3].count, 3, "the rollup leg's count of the 3 notes just written");

    // The same data out of the two flat calls the composed one replaced --
    // one call instead of two, a count and not a claim about speed.
    const page = await client.invoke(url, "notes.by_topic", { topic });
    const rollup = await client.invoke(url, "notes.total_by_topic", { topic });
    assert.equal(page.rows.length + rollup.rows.length, result.rows.length);
  } finally {
    await client.close();
  }
});

test("a composed operation whose steps may return more rows than its own declared limit is refused, in the store's own words", { skip }, async () => {
  const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
  const client = new Made();

  try {
    await client.elevate(url, SECRET);

    await assert.rejects(
      () =>
        client.declare(url, {
          name: "notes.page_over_ceiling",
          collection: "notes",
          action: "batch",
          // notes.by_topic's ceiling is 10 and notes.total_by_topic's is 1:
          // 11 rows between them, the same two legs the positive control
          // above declared at a limit of 11. This declares one row short.
          limit: 10,
          input: [{ name: "topic", type: "string", required: true }],
          steps: [
            { name: "page", operation: "notes.by_topic", version: 1, with: { topic: { arg: "topic" } } },
            { name: "total", operation: "notes.total_by_topic", version: 1, with: { topic: { arg: "topic" } } },
          ],
        }),
      (error) => {
        assert.ok(error instanceof Refused, `want Refused, got ${error.constructor.name}: ${error.message}`);
        assert.equal(error.code, "declaration");
        // The store's own words -- see internal/store/ops.go's N5 check, the
        // sum of the steps' ceilings against the parent's own declared limit.
        assert.equal(
          error.message,
          '[ecosy/sapedb] sapedb/store: the declaration does not make sense: the steps of "notes.page_over_ceiling" may return 11 rows between them, and it declares a limit of 10',
        );
        return true;
      },
    );
  } finally {
    await client.close();
  }
});

test("a step that takes an earlier step's key from a leg that may answer more than one row is refused", { skip }, async () => {
  const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
  const client = new Made();

  try {
    await client.elevate(url, SECRET);

    await assert.rejects(
      () =>
        client.declare(url, {
          name: "notes.take_key_from_a_scan",
          collection: "notes",
          action: "batch",
          limit: 20,
          input: [{ name: "topic", type: "string", required: true }],
          steps: [
            // Ceiling 10 -- notes.by_topic's own declared limit.
            { name: "page", operation: "notes.by_topic", version: 1, with: { topic: { arg: "topic" } } },
            // Reaching for "page"'s key is refused before this step is ever
            // run: a step that may return 10 rows has, at best, the last of
            // them to give, and taking one is a loop written in JSON -- see
            // internal/store/ops.go's N4 check.
            {
              name: "next",
              operation: "notes.add",
              version: 1,
              with: { body: { step: "page", field: "key" }, topic: { arg: "topic" } },
            },
          ],
        }),
      (error) => {
        assert.ok(error instanceof Refused, `want Refused, got ${error.constructor.name}: ${error.message}`);
        assert.equal(error.code, "declaration");
        assert.equal(
          error.message,
          '[ecosy/sapedb] sapedb/store: the declaration does not make sense: step "next" passing "body" to "notes.add" names step "page", which may return 10 rows — a step runs once, and taking a value from a step that returns more than one row is asking to run once for each of them',
        );
        return true;
      },
    );
  } finally {
    await client.close();
  }
});

test("catalogue on a database with nothing declared yet answers empty lists, not null", { skip }, async () => {
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

      /* This used to answer `null`: Collections carries no `omitempty` and the
         loop that fills it only ever appends, so on a database that has never
         had anything declared it stayed a nil slice and marshalled as JSON
         `null`. A caller that assumed `[]` and reached straight for `.map`
         broke on exactly the database that most needs this read to work --
         the empty one, which is everybody's first. The server now builds the
         slice empty rather than nil, so both lists answer `[]`. */
      assert.deepEqual(explored.here.collections, [], "an empty database should answer [], not null");
      assert.deepEqual(explored.here.operations, []);
    } finally {
      await client.close();
    }
  } finally {
    proc.kill("SIGTERM");
  }
});

/* ---- ISS-12: presenting a scope grant ----
 *
 * Before this, `grep -riF grant src/` found nothing: the driver had no way to
 * attach a grant to a call, so an operation declaring `scopes` was one this
 * client could never run — the Go client could (`Client.Present`,
 * sapedb.go), so scope was a feature two of three clients could use. Four
 * cases, each measured against the positive control it needs to mean
 * anything:
 *
 *  1. The positive control itself: an unscoped operation runs with no grant
 *     and answers real rows. If `notes` were empty this would pass for the
 *     wrong reason, so it writes its own row first and checks the count.
 *  2. The scoped twin of that same read, called with no grant at all: refused
 *     `not_allowed`, naming the missing scope.
 *  3. The scoped twin, called with a grant this test mints correctly: it
 *     runs, and answers the same real row case 1 proved existed — the thing
 *     that was impossible before this change.
 *  4. The scoped twin, called with a grant whose signature is wrong: refused
 *     `grant`, not `not_allowed` — a bad credential is a different problem
 *     from a missing permission, and the two must not collapse into one code.
 */
test("ISS-12: an unscoped read runs with no grant and answers real data (positive control)", { skip }, async () => {
  const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
  const client = new Made();

  try {
    const topic = "iss-12-baseline";
    const written = await client.invoke(url, "notes.add", { body: "unscoped and fine", topic }, { write: true });
    assert.equal(typeof written.key, "string");

    const read = await client.invoke(url, "notes.by_topic", { topic });
    assert.equal(read.count, 1, "the collection must not be empty, or every case below proves nothing");
    assert.equal(read.rows[0].body, "unscoped and fine");
  } finally {
    await client.close();
  }
});

test("ISS-12: the scoped twin of that same read, called with no grant, is refused not_allowed naming the missing scope", { skip }, async () => {
  const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
  const client = new Made();

  try {
    const topic = "iss-12-no-grant";
    await client.invoke(url, "notes.add", { body: "should stay unreadable here", topic }, { write: true });

    await assert.rejects(
      () => client.invoke(url, "notes.by_topic_scoped", { topic }),
      (error) => {
        assert.ok(error instanceof Refused, `want Refused, got ${error.constructor.name}: ${error.message}`);
        assert.equal(error.code, "not_allowed");
        assert.match(error.message, /notes:scoped_read/, "the refusal must name the scope that was missing");
        return true;
      },
    );
  } finally {
    await client.close();
  }
});

test("ISS-12: the same scoped read, presented with a valid grant, runs and answers the real row (impossible before this change)", { skip }, async () => {
  const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
  const client = new Made();

  try {
    const topic = "iss-12-valid-grant";
    const written = await client.invoke(url, "notes.add", { body: "readable with a grant", topic }, { write: true });
    assert.equal(typeof written.key, "string");

    const scopes = ["notes:scoped_read"];
    const sig = mintGrant(SECRET, "acme", "main", scopes);

    const read = await client.invoke(url, "notes.by_topic_scoped", { topic }, { grant: { scopes, sig } });
    assert.equal(read.count, 1, "the collection must not be empty, or this proves nothing");
    assert.equal(read.rows[0].body, "readable with a grant");
  } finally {
    await client.close();
  }
});

test("ISS-12: a grant with the wrong signature is refused grant, not not_allowed", { skip }, async () => {
  const Made = Client({ transport: nodeTransport({ insecure: true }), mode: "bound", requestTimeout: 5000 });
  const client = new Made();

  try {
    const topic = "iss-12-bad-signature";
    await client.invoke(url, "notes.add", { body: "should stay unreadable here too", topic }, { write: true });

    const scopes = ["notes:scoped_read"];
    // Minted under the right message but the wrong secret — the shape of a
    // forged, copied, or edited grant, not a typo in the scope list.
    const sig = mintGrant("not-the-real-secret", "acme", "main", scopes);

    await assert.rejects(
      () => client.invoke(url, "notes.by_topic_scoped", { topic }, { grant: { scopes, sig } }),
      (error) => {
        assert.ok(error instanceof Refused, `want Refused, got ${error.constructor.name}: ${error.message}`);
        assert.equal(error.code, "grant", "a grant that does not verify must be refused by its own code, not folded into not_allowed");
        return true;
      },
    );
  } finally {
    await client.close();
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
