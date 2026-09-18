/* Against the built package in dist/, the thing that ships. */
import { test } from "node:test";
import assert from "node:assert/strict";

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

      return connection;
    },
  };

  return { transport, connections, attempts: () => attempts };
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
