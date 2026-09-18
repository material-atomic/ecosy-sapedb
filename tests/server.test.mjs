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
    await assert.rejects(() => client.invoke(forged, "notes.by_topic", { topic: "bound" }));
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

/** waitFor polls a condition, so a test that is wrong fails instead of hanging. */
async function waitFor(condition, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}
