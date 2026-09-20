/* Against the built package in dist/, the thing that ships. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { Client } = await import(new URL("../dist/client/index.mjs", import.meta.url).href);
const { FrameDecoder, encodeJsonFrame, decodeJsonPayload, FrameType } = await import(
  new URL("../dist/protocol/index.mjs", import.meta.url).href
);
const { Unavailable, Refused } = await import(new URL("../dist/errors.mjs", import.meta.url).href);

const quiet = { warn() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const url = (account = "acc", db = "main", host = "store.example.com") =>
  `sapedb://${account}:${"y".repeat(16)}@${host}:7433/${db}?sig=${"a".repeat(64)}`;

/**
 * A store that answers over an in-memory pair of pipes: what it was asked,
 * what it answered, and what it did to the connection.
 */
function fakeStore({ answer, failConnect = 0, dropFirstCall = false } = {}) {
  const connections = [];
  let attempts = 0;

  const transport = {
    async connect(target) {
      attempts++;
      if (attempts <= failConnect) throw new Error("connection refused");

      const frameHandlers = [];
      const closeHandlers = [];
      const decoder = new FrameDecoder();
      const record = { target, hello: null, calls: [], sent: 0, closed: false };
      connections.push(record);

      const connection = {
        send(bytes) {
          if (record.closed) throw new Error("socket is closed");
          record.sent++;

          for (const frame of decoder.push(bytes)) {
            const body = decodeJsonPayload(frame);

            if (frame.type === FrameType.hello) {
              record.hello = body;
              queueMicrotask(() => frameHandlers.forEach((handler) => handler(encodeJsonFrame(FrameType.welcome, 0, { ok: true }))));
              continue;
            }

            if (frame.type === FrameType.ping) {
              queueMicrotask(() => frameHandlers.forEach((handler) => handler(encodeJsonFrame(FrameType.pong, frame.id, null))));
              continue;
            }

            record.calls.push(body);

            // Only the first connection drops its first call, so a retry can succeed.
            if (dropFirstCall && connections.length === 1 && record.calls.length === 1) {
              record.closed = true;
              queueMicrotask(() => closeHandlers.forEach((handler) => handler("the store went away")));
              continue;
            }

            const reply = answer?.(body, record) ?? { rows: [] };
            const send = () => frameHandlers.forEach((handler) => handler(encodeJsonFrame(reply.type ?? FrameType.result, frame.id, reply.body ?? reply)));
            if (reply.delay) setTimeout(send, reply.delay);
            else queueMicrotask(send);
          }
        },
        onFrame(handler) {
          // The driver hands us bytes; give it back decoded frames.
          frameHandlers.push((bytes) => new FrameDecoder().push(bytes).forEach(handler));
        },
        onClose(handler) {
          closeHandlers.push(handler);
        },
        close() {
          record.closed = true;
        },
      };

      // For a test that wants a close with no failure ever sent on the wire:
      // the real socket cases (dropFirstCall, and this) are the only ways
      // fakeStore ends a connection, and neither one runs through a Failure
      // frame first.
      record.forceClose = (reason) => {
        record.closed = true;
        closeHandlers.forEach((handler) => handler(reason));
      };

      return connection;
    },
  };

  return { transport, connections, attempts: () => attempts };
}

/**
 * A store that refuses every handshake it is offered: it answers whatever it
 * is sent with a Failure at id 0 and then closes, the way sapedbd looks at
 * mode `bound` when a signature does not verify. The reply is put off with
 * `setTimeout` rather than a microtask on purpose — `open()` does not wait
 * for a Welcome before handing the connection back, so the driver's own call
 * frame goes out on the same connection right after hello; a microtask reply
 * could in principle race ahead of that send, and a macrotask cannot.
 */
function refusingStore({ message = "sapedb: signature does not verify", code = "signature" } = {}) {
  let attempts = 0;

  const transport = {
    async connect() {
      attempts++;
      const frameHandlers = [];
      const closeHandlers = [];
      let refused = false;

      const connection = {
        send(bytes) {
          for (const frame of new FrameDecoder().push(bytes)) {
            if (frame.type === FrameType.hello && !refused) {
              refused = true;
              setTimeout(() => {
                frameHandlers.forEach((handler) => handler(encodeJsonFrame(FrameType.failure, 0, { message, code })));
                closeHandlers.forEach((handler) => handler("handshake rejected"));
              }, 0);
            }
            // Any other frame sent on this connection — the real call
            // `open()` let through without waiting for a Welcome — is left
            // unanswered; the refusal above is what ends it.
          }
        },
        onFrame(handler) {
          frameHandlers.push((bytes) => new FrameDecoder().push(bytes).forEach(handler));
        },
        onClose(handler) {
          closeHandlers.push(handler);
        },
        close() {},
      };

      return connection;
    },
  };

  return { transport, attempts: () => attempts };
}

/**
 * A store that answers hello with a Welcome and then answers nothing else on
 * its own — every other frame just sits there until the test calls
 * `connection.emit(...)` or `connection.forceClose(...)` itself. fakeStore's
 * generic auto-reply (queued the instant a frame is sent) is exactly what
 * these two tests need to not happen: they need a call still sitting in
 * `entry.pending` at the moment the connection ends, on purpose.
 */
function silentStore() {
  const connections = [];

  const transport = {
    async connect() {
      const frameHandlers = [];
      const closeHandlers = [];
      const record = { calls: [] };
      connections.push(record);

      const connection = {
        send(bytes) {
          for (const frame of new FrameDecoder().push(bytes)) {
            if (frame.type === FrameType.hello) {
              queueMicrotask(() => frameHandlers.forEach((handler) => handler(encodeJsonFrame(FrameType.welcome, 0, { ok: true }))));
              continue;
            }
            record.calls.push(frame);
          }
        },
        onFrame(handler) {
          frameHandlers.push((bytes) => new FrameDecoder().push(bytes).forEach(handler));
        },
        onClose(handler) {
          closeHandlers.push(handler);
        },
        close() {},
      };

      record.emit = (type, id, body) => frameHandlers.forEach((handler) => handler(encodeJsonFrame(type, id, body)));
      record.forceClose = (reason) => closeHandlers.forEach((handler) => handler(reason));

      return connection;
    },
  };

  return { transport, connections };
}

test("nothing opens until the first call", async () => {
  const store = fakeStore({ answer: () => ({ rows: [1] }) });
  const client = new (Client({ transport: store.transport, logger: quiet }))();

  assert.equal(store.attempts(), 0);
  assert.deepEqual(client.stats(), { connections: 0, inFlight: 0, tripped: [] });

  assert.deepEqual(await client.invoke(url(), "orders.list"), { rows: [1] });
  assert.equal(store.attempts(), 1);
});

test("the handshake fixes the account, and a call names its database", async () => {
  const store = fakeStore({ answer: (body) => ({ seen: body }) });
  const client = new (Client({ transport: store.transport, logger: quiet }))();

  await client.invoke(url("acc", "main"), "orders.list", { limit: 2 });

  const [connection] = store.connections;
  assert.equal(connection.hello.account, "acc");
  assert.equal(connection.hello.mode, "account");
  assert.equal(connection.hello.dbname, undefined, "an account-wide connection is not tied to one database");
  assert.deepEqual(connection.calls[0], {
    command: "orders.list",
    args: { limit: 2 },
    dbname: "main",
    sig: "a".repeat(64),
  });
});

test("one connection serves every database of an account", async () => {
  const store = fakeStore({ answer: () => ({ ok: true }) });
  const client = new (Client({ transport: store.transport, logger: quiet }))();

  await client.invoke(url("acc", "one"), "a");
  await client.invoke(url("acc", "two"), "b");
  await client.invoke(url("other", "one"), "c");

  assert.equal(store.connections.length, 2, "two accounts, two connections");
  assert.deepEqual(
    store.connections[0].calls.map((call) => call.dbname),
    ["one", "two"],
  );
  assert.equal(client.stats().connections, 2);
  await client.close();
  assert.equal(client.stats().connections, 0);
});

test("bound mode ties the connection to one database, and calls name none", async () => {
  const store = fakeStore({ answer: () => ({ ok: true }) });
  const client = new (Client({ transport: store.transport, mode: "bound", logger: quiet }))();

  await client.invoke(url("acc", "one"), "a");
  await client.invoke(url("acc", "two"), "b");

  assert.equal(store.connections.length, 2, "one database, one connection");
  assert.equal(store.connections[0].hello.dbname, "one");
  assert.equal(store.connections[0].calls[0].dbname, undefined);
});

test("calls in flight are told apart by their id, and answers may come back out of order", async () => {
  const store = fakeStore({
    answer: (body) => ({ body: { command: body.command }, delay: body.command === "slow" ? 20 : 0 }),
  });
  const client = new (Client({ transport: store.transport, logger: quiet }))();

  const slow = client.invoke(url(), "slow");
  const fast = await client.invoke(url(), "fast");

  assert.deepEqual(fast, { command: "fast" });
  assert.deepEqual(await slow, { command: "slow" });
  assert.equal(store.connections.length, 1, "both travelled over one socket");
});

test("a failure frame is the store saying no, which retrying cannot change", async () => {
  const store = fakeStore({
    answer: () => ({ type: FrameType.failure, body: { message: "no such command", code: "unknown_command" } }),
  });
  const client = new (Client({ transport: store.transport, logger: quiet }))();

  await assert.rejects(
    () => client.invoke(url(), "nope"),
    (error) => error instanceof Refused && error.code === "unknown_command",
  );
  assert.equal(store.connections[0].calls.length, 1, "a refusal is not retried");
});

test("a dropped connection is retried once for a read", async () => {
  const store = fakeStore({ dropFirstCall: true, answer: () => ({ rows: ["from the second connection"] }) });
  const client = new (Client({ transport: store.transport, logger: quiet }))();

  assert.deepEqual(await client.invoke(url(), "orders.list"), { rows: ["from the second connection"] });
  assert.equal(store.attempts(), 2, "the first connection dropped the call, a new one carried it");
  assert.equal(client.stats().inFlight, 0);
});

test("a write carries an id, and the same id on the retry", async () => {
  const store = fakeStore({ dropFirstCall: true, answer: () => ({ ok: true }) });
  const client = new (Client({ transport: store.transport, logger: quiet }))();

  await client.invoke(url(), "orders.create", { total: 10 }, { write: true });

  // Taken from what reached the store, so the dropped attempt counts too.
  const ids = store.connections.flatMap((connection) => connection.calls.map((call) => call.writeId));
  assert.equal(ids.length, 2, "the first attempt was dropped, the second landed");
  assert.equal(typeof ids[0], "string");
  assert.equal(ids[0].length, 26, "a ULID: time-ordered, made by the caller");
  assert.equal(ids[0], ids[1], "a retry must not look like a second write");
});

test("a read is retried without an id; a write with one given by the caller keeps it", async () => {
  const seen = [];
  const store = fakeStore({ answer: (body) => (seen.push(body.writeId), { ok: true }) });
  const client = new (Client({ transport: store.transport, logger: quiet }))();

  await client.invoke(url(), "orders.list");
  await client.invoke(url(), "orders.create", {}, { writeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });

  assert.deepEqual(seen, [undefined, "01ARZ3NDEKTSV4RRFFQ69G5FAV"], "a read needs no id; an id the caller kept is the one sent");
});

test("invoke sends no grant field when none was given, matching the wire from before grants existed", async () => {
  const seen = [];
  const store = fakeStore({ answer: (body) => (seen.push(body), { ok: true }) });
  const client = new (Client({ transport: store.transport, logger: quiet }))();

  await client.invoke(url(), "orders.list");

  assert.equal("grant" in seen[0], false, "a call with no grant option must not carry the field at all");
});

test("a grant given to invoke reaches the wire as {scopes, exp, serial, sig}, ISS-12/ISS-11", async () => {
  const seen = [];
  const store = fakeStore({ answer: (body) => (seen.push(body), { ok: true }) });
  const client = new (Client({ transport: store.transport, logger: quiet }))();

  await client.invoke(
    url(),
    "articles.by_author",
    { author: "ann" },
    { grant: { scopes: ["articles:read", "reports"], exp: 1789995600, serial: "01K5ZQ9P7B3N4M6R8T0V2W4X6Y", sig: "deadbeef" } },
  );

  assert.deepEqual(
    seen[0].grant,
    { scopes: ["articles:read", "reports"], exp: 1789995600, serial: "01K5ZQ9P7B3N4M6R8T0V2W4X6Y", sig: "deadbeef" },
    "the grant must reach the wire exactly as given, under the field names the server reads",
  );
});

/* ---- ISS-11: grant carries exp and serial, checked against the shared fixture ----
 *
 * fixtures/signing.json gained a top-level "grant" section (refreshed from
 * the server at commit eab1674) with seven vectors, each carrying its
 * fields, the exact message bytes the server signs, and the sig those bytes
 * produce. This client never computes that message or that signature — it
 * only carries the fields it was handed — but that is exactly what these
 * vectors let this suite check for the first time: against a contract
 * neither side wrote for the occasion, not against this package's own
 * assumptions about itself.
 *
 * `canonicalScopeList` and `grantMessage` below are test-only tooling, the
 * same as `mintGrant` in tests/server.test.mjs — reproducing
 * `internal/signing/signing.go`'s `scopeList` and `GrantMessage` to prove
 * this suite's understanding of the wire against the fixture, not something
 * this package ships or needs at runtime.
 */
const fixture = JSON.parse(readFileSync(new URL("../fixtures/signing.json", import.meta.url), "utf8"));

function canonicalScopeList(scopes) {
  return [...new Set(scopes)].sort().join(",");
}

function counted(value) {
  return `${Buffer.byteLength(value, "utf8")}:${value}\n`;
}

function grantMessage({ accountId, dbname, scopes, exp, serial }) {
  return (
    "sapedb/scopes:v2\n" +
    counted(accountId) +
    counted(dbname) +
    counted(canonicalScopeList(scopes)) +
    counted(String(exp)) +
    counted(serial)
  );
}

test("fixture: the grant section exists, is v2, and carries all seven vectors", () => {
  // An empty result is not evidence — this is the positive control for every
  // test below that reads fixture.grant.cases: if the section were missing
  // or came back empty, every one of them would iterate zero times and pass
  // having asserted nothing.
  assert.ok(fixture.grant, "fixtures/signing.json must carry a top-level grant section");
  assert.equal(fixture.grant.label, "sapedb/scopes:v2");
  assert.equal(fixture.grant.cases.length, 7, "the refreshed fixture ships exactly seven grant vectors");
});

test("fixture: this suite's own reconstruction of the signed message matches every vector, byte for byte", () => {
  for (const vector of fixture.grant.cases) {
    assert.equal(grantMessage(vector), vector.message, vector.name);
  }
});

test("fixture: the payload invoke() builds for a vector's fields matches that vector exactly", async () => {
  for (const vector of fixture.grant.cases) {
    const seen = [];
    const store = fakeStore({ answer: (body) => (seen.push(body), { ok: true }) });
    const client = new (Client({ transport: store.transport, logger: quiet }))();

    await client.invoke(
      url(),
      "articles.by_author",
      {},
      { grant: { scopes: vector.scopes, exp: vector.exp, serial: vector.serial, sig: vector.sig } },
    );

    assert.deepEqual(
      seen[0].grant,
      { scopes: vector.scopes, exp: vector.exp, serial: vector.serial, sig: vector.sig },
      `${vector.name}: the wire body must carry exactly this vector's fields`,
    );
  }
});

test("fixture: vectors 1 and 2 (same scopes, reordered, with a repeat) canonicalise to the identical scope list and message", () => {
  const [plain, reordered] = fixture.grant.cases;

  assert.notDeepEqual(plain.scopes, reordered.scopes, "the two vectors must be written differently, or this proves nothing");
  assert.equal(canonicalScopeList(plain.scopes), canonicalScopeList(reordered.scopes));
  assert.equal(canonicalScopeList(reordered.scopes), "articles:read,billing:write");
  assert.equal(grantMessage(plain), grantMessage(reordered), "reordering and repeating a scope must not change the signed message");
  assert.equal(plain.sig, reordered.sig, "the fixture itself must agree they sign identically");
});

test("fixture: vectors 5 and 6 are the collision pair a colon-joined message would confuse, and must differ here", () => {
  const [eatsExpiry, otherHalf] = fixture.grant.cases.slice(4, 6);

  assert.deepEqual(eatsExpiry.scopes, ["x"]);
  assert.equal(eatsExpiry.exp, 100);
  assert.equal(eatsExpiry.serial, "200:z");
  assert.deepEqual(otherHalf.scopes, ["x:100"]);
  assert.equal(otherHalf.exp, 200);
  assert.equal(otherHalf.serial, "z");

  // The naive delimiter-joined form both tuples would produce, if the
  // message were "account:dbname:scopes:exp:serial" instead of
  // length-prefixed — this is the collision ISS-11 exists to close.
  const naive = (v) => `acme:main:${canonicalScopeList(v.scopes)}:${v.exp}:${v.serial}`;
  assert.equal(naive(eatsExpiry), naive(otherHalf), "the naive join must collide, or this is not the pair the ticket describes");

  // The actual, length-prefixed message must not.
  assert.notEqual(grantMessage(eatsExpiry), grantMessage(otherHalf), "the real message must not collide where the naive one does");
  assert.notEqual(eatsExpiry.sig, otherHalf.sig, "two different grants must not share one signature");
});

test("a store that will not answer costs one timeout, not a hung call", async () => {
  const store = fakeStore({ answer: () => ({ delay: 5_000 }) });
  const client = new (Client({ transport: store.transport, requestTimeout: 30, logger: quiet }))();

  await assert.rejects(() => client.invoke(url(), "slow"), (error) => error instanceof Unavailable && /did not answer/.test(error.message));
});

test("after enough failures the breaker fails fast, then lets one through again", async () => {
  const store = fakeStore({ failConnect: 10, answer: () => ({ ok: true }) });
  const client = new (Client({
    transport: store.transport,
    connectTimeout: 20,
    breaker: { failures: 2, cooldown: 60 },
    logger: quiet,
  }))();

  await assert.rejects(() => client.invoke(url(), "a"), Unavailable);
  await assert.rejects(() => client.invoke(url(), "a"), Unavailable);
  const attemptsAfterTrip = store.attempts();

  await assert.rejects(
    () => client.invoke(url(), "a"),
    (error) => error instanceof Unavailable && /not trying again for now/.test(error.message),
  );
  assert.equal(store.attempts(), attemptsAfterTrip, "the breaker did not touch the network");
  assert.deepEqual(client.stats().tripped, ["acc@store.example.com:7433"]);

  await sleep(80);
  await assert.rejects(() => client.invoke(url(), "a"), Unavailable);
  assert.ok(store.attempts() > attemptsAfterTrip, "after the cooldown it tries again");
});

test("ping goes down the same path everything else does", async () => {
  const store = fakeStore({ answer: () => ({ ok: true }) });
  const client = new (Client({ transport: store.transport, logger: quiet }))();

  const ms = await client.ping(url());
  assert.equal(typeof ms, "number");
  assert.ok(ms >= 0);
  assert.equal(store.connections[0].calls.length, 0, "a ping is not a call");
});

test("an idle connection is closed, and the next call opens another", async () => {
  const store = fakeStore({ answer: () => ({ ok: true }) });
  const client = new (Client({ transport: store.transport, idleTimeout: 30, keepAlive: 0, logger: quiet }))();

  await client.invoke(url(), "a");
  assert.equal(client.stats().connections, 1);

  await sleep(60);
  assert.equal(client.stats().connections, 0, "nothing is held open for a store nobody is using");

  await client.invoke(url(), "b");
  assert.equal(store.attempts(), 2);
});

test("storageKey shares the pool across two Client() calls", async () => {
  const key = `client-${Math.random().toString(36).slice(2)}`;
  const store = fakeStore({ answer: () => ({ ok: true }) });

  const a = new (Client({ transport: store.transport, logger: quiet, storageKey: key }))();
  const b = new (Client({ transport: store.transport, logger: quiet, storageKey: key }))();

  await a.invoke(url(), "one");
  await b.invoke(url(), "two");

  assert.equal(store.connections.length, 1, "the second copy of the module found the first one's connection");
  assert.equal(b.stats().connections, 1);
  await b.close();
});

test("a client needs a transport, and a call needs a command", async () => {
  assert.throws(() => Client({}), TypeError);
  const client = new (Client({ transport: fakeStore().transport, logger: quiet }))();
  await assert.rejects(() => client.invoke(url(), ""), TypeError);
});

// --- 0048: a rejected handshake used to reach the caller as an unhelpful
// Unavailable, when the store had already said exactly why and with what
// code. See CHANGELOG.md and internal/server task 0048 on the Go side. ---

test("a handshake the store refuses settles the call that opened it with Refused, not a vague Unavailable", async () => {
  const store = refusingStore({ message: "sapedb: signature does not verify", code: "signature" });
  const client = new (Client({ transport: store.transport, mode: "bound", logger: quiet }))();

  await assert.rejects(
    () => client.invoke(url(), "orders.list"),
    (error) =>
      error instanceof Refused &&
      // T5: the code has to be the server's, not dropped.
      error.code === "signature" &&
      // T6: the server's own wording, not the driver's fallback text — the
      // two must not read alike, or this assertion would pass by accident.
      error.message.includes("signature does not verify") &&
      !error.message.includes("the store refused the connection"),
  );
});

test("a store that keeps refusing rejects the next call the same way, not just the first", async () => {
  const store = refusingStore({ message: "sapedb: signature does not verify", code: "signature" });
  const client = new (Client({ transport: store.transport, mode: "bound", logger: quiet }))();

  await assert.rejects(() => client.invoke(url(), "a"), (error) => error instanceof Refused && error.code === "signature");
  // The first attempt's Entry was torn down and deleted; this is a second,
  // unrelated connection attempt reaching the very same refusal.
  await assert.rejects(() => client.invoke(url(), "b"), (error) => error instanceof Refused && error.code === "signature");
  assert.ok(store.attempts() >= 2, "each call opened its own connection, and each one was refused");
});

test("a refused handshake does not trip the breaker — only open() throwing does, and open() does not throw here", async () => {
  const store = refusingStore();
  const client = new (Client({
    transport: store.transport,
    mode: "bound",
    breaker: { failures: 2, cooldown: 10_000 },
    logger: quiet,
  }))();

  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => client.invoke(url(), "a"), Refused);
  }
  assert.deepEqual(client.stats().tripped, [], "a Refused is the store answering, not open() failing — the breaker never saw it");
});

test("a socket closing with no Failure ever sent still settles with the old, generic Unavailable", async () => {
  // The counter-case section 6 asks for: without this, a mutant that remembers
  // a "refusal" for any id-0 frame — Welcome included — would misread an
  // ordinary handshake this way too.
  //
  // ping(), not invoke(): invoke() retries once, on its own, whenever the
  // error is Unavailable — that is the whole point of the retry — so it
  // would silently swallow this test's Unavailable behind a second, quietly
  // successful attempt. ping() carries no such retry. And silentStore, not
  // fakeStore: fakeStore answers every frame the moment it is sent, so the
  // ping would already have resolved before this test got a chance to close
  // the socket out from under it.
  const store = silentStore();
  const client = new (Client({ transport: store.transport, logger: quiet }))();

  const pending = client.ping(url());
  await sleep(0); // let the ping frame actually go out and land in entry.pending
  const [connection] = store.connections;
  connection.forceClose("the process was killed");

  await assert.rejects(pending, (error) => error instanceof Unavailable && /closed the connection/.test(error.message));
});

test("a Failure with a real id is not remembered as a handshake refusal for an unrelated later close", async () => {
  // T7, the boundary mutant task 0048 names explicitly: capturing a
  // "refusal" for any id 0 frame is the in-bounds bug; capturing one for a
  // real id too is the out-of-bounds version, and it is nastier — the old
  // failure's message and code would sit in entry.refusal and mislead
  // whichever later, unrelated call happens to be pending when the
  // connection eventually drops for its own, different reason.
  const store = silentStore();
  const client = new (Client({ transport: store.transport, logger: quiet }))();

  // subscribe(), not invoke(): it carries no retry either, and it is what
  // gives this test a real id to answer by hand, on a store that otherwise
  // answers nothing on its own.
  const first = client.subscribe(url(), { from: 0 }, () => {});
  await sleep(0);
  const [connection] = store.connections;
  const subscribeFrame = connection.calls.at(-1);
  connection.emit(FrameType.failure, subscribeFrame.id, { message: "no such command", code: "unknown_command" });

  await assert.rejects(first, (error) => error instanceof Refused && error.code === "unknown_command");

  // That failure carried a real id and rejected its own call normally; the
  // connection itself is still open (a Refused from a named call does not
  // teardown anything). A ping stands in for a second, unrelated call.
  const second = client.ping(url());
  await sleep(0);
  connection.forceClose("unrelated network hiccup");

  await assert.rejects(
    second,
    (error) => error instanceof Unavailable && /closed the connection/.test(error.message),
    "the old command-not-found failure must not resurface as this call's rejection",
  );
});
