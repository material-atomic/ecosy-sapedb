/* Against the built package in dist/, the thing that ships. */
import { test } from "node:test";
import assert from "node:assert/strict";

const { encodeFrame, encodeJsonFrame, decodeJsonPayload, FrameDecoder, FrameType, frameTypeName, VERSION, HEADER_BYTES, MAX_PAYLOAD } =
  await import(new URL("../dist/protocol/index.mjs", import.meta.url).href);
const { ProtocolError } = await import(new URL("../dist/errors.mjs", import.meta.url).href);

const bytes = (...values) => new Uint8Array(values);
const decodeOne = (chunk, options) => {
  const frames = new FrameDecoder(options).push(chunk);
  assert.equal(frames.length, 1);
  return frames[0];
};

test("the header is version, type, id, length — in that order, big-endian", () => {
  const frame = encodeFrame({ type: FrameType.invoke, id: 0x01020304, payload: bytes(9, 9) });

  assert.equal(frame.length, HEADER_BYTES + 2);
  assert.deepEqual([...frame.slice(0, HEADER_BYTES)], [VERSION, FrameType.invoke, 0x01, 0x02, 0x03, 0x04, 0, 0, 0, 2]);
  assert.deepEqual([...frame.slice(HEADER_BYTES)], [9, 9]);
});

test("a frame round-trips, id and all", () => {
  const frame = decodeOne(encodeFrame({ type: FrameType.result, id: 7, payload: bytes(1, 2, 3) }));

  assert.equal(frame.version, VERSION);
  assert.equal(frame.type, FrameType.result);
  assert.equal(frame.id, 7);
  assert.deepEqual([...frame.payload], [1, 2, 3]);
});

test("id 0 is for frames nobody asked for", () => {
  const event = decodeOne(encodeJsonFrame(FrameType.event, 0, { lsn: 12 }));
  assert.equal(event.id, 0);
  assert.deepEqual(decodeJsonPayload(event), { lsn: 12 });
});

test("frame types have names, and an unknown code has none", () => {
  assert.equal(frameTypeName(FrameType.ping), "ping");
  assert.equal(frameTypeName(FrameType.subscribe), "subscribe");
  assert.equal(frameTypeName(200), undefined);
  assert.deepEqual(Object.keys(FrameType), [
    "hello", "welcome", "ping", "pong", "invoke", "result", "failure", "subscribe", "event", "goodbye",
  ]);
});

test("a stream is not a sequence of messages: header split, payload split, several at once", () => {
  const a = encodeJsonFrame(FrameType.invoke, 1, { op: "orders.list" });
  const b = encodeJsonFrame(FrameType.result, 1, { rows: 2 });
  const c = encodeFrame({ type: FrameType.ping, id: 2, payload: new Uint8Array(0) });
  const stream = new Uint8Array([...a, ...b, ...c]);

  const decoder = new FrameDecoder();
  const seen = [];

  // Half a header first.
  seen.push(...decoder.push(stream.slice(0, 4)));
  assert.deepEqual(seen, []);
  assert.equal(decoder.pending, 4);

  // Then the rest of the first frame and a slice of the second's payload.
  seen.push(...decoder.push(stream.slice(4, a.length + HEADER_BYTES + 3)));
  assert.equal(seen.length, 1);
  assert.deepEqual(decodeJsonPayload(seen[0]), { op: "orders.list" });

  // Then everything that is left: two more frames arrive together.
  seen.push(...decoder.push(stream.slice(a.length + HEADER_BYTES + 3)));
  assert.equal(seen.length, 3);
  assert.deepEqual(decodeJsonPayload(seen[1]), { rows: 2 });
  assert.equal(seen[2].type, FrameType.ping);
  assert.equal(decoder.pending, 0);
});

test("an empty chunk changes nothing", () => {
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(new Uint8Array(0)), []);
  assert.deepEqual(decoder.push(encodeFrame({ type: FrameType.pong, id: 3, payload: new Uint8Array(0) })).length, 1);
});

test("a version this side does not read is an error, not a guess", () => {
  const frame = encodeFrame({ type: FrameType.ping, id: 1, payload: new Uint8Array(0), version: 99 });

  assert.throws(() => new FrameDecoder().push(frame), ProtocolError);
  assert.equal(new FrameDecoder({ versions: [VERSION, 99] }).push(frame)[0].version, 99);
});

test("a length is a promise about an allocation, so it has a limit", () => {
  const big = encodeFrame({ type: FrameType.result, id: 1, payload: new Uint8Array(64) }, { maxPayload: 128 });
  assert.throws(() => new FrameDecoder({ maxPayload: 32 }).push(big), /over the 32 byte limit/);

  assert.throws(
    () => encodeFrame({ type: FrameType.result, id: 1, payload: new Uint8Array(64) }, { maxPayload: 32 }),
    ProtocolError,
  );

  // A header claiming more than the limit is refused before a byte of it arrives.
  const header = new Uint8Array(HEADER_BYTES);
  const view = new DataView(header.buffer);
  header[0] = VERSION;
  header[1] = FrameType.result;
  view.setUint32(2, 1, false);
  view.setUint32(6, MAX_PAYLOAD + 1, false);
  assert.throws(() => new FrameDecoder().push(header), ProtocolError);
});

test("encode refuses what will not fit the header", () => {
  assert.throws(() => encodeFrame({ type: 256, id: 0, payload: new Uint8Array(0) }), ProtocolError);
  assert.throws(() => encodeFrame({ type: 1, id: -1, payload: new Uint8Array(0) }), ProtocolError);
  assert.throws(() => encodeFrame({ type: 1, id: 2 ** 32, payload: new Uint8Array(0) }), ProtocolError);
  assert.throws(() => encodeFrame({ type: 1, id: 1.5, payload: new Uint8Array(0) }), ProtocolError);
});

test("JSON payloads: null for an empty one, and a broken one is a protocol error", () => {
  assert.equal(decodeJsonPayload({ type: 1, id: 0, payload: new Uint8Array(0) }), null);
  assert.deepEqual(decodeJsonPayload(decodeOne(encodeJsonFrame(FrameType.hello, 1, { account: "acc" }))), { account: "acc" });

  assert.throws(() => decodeJsonPayload({ type: FrameType.result, id: 1, payload: bytes(123, 34) }), /did not carry JSON/);
  assert.throws(() => decodeJsonPayload({ type: FrameType.result, id: 1, payload: bytes(0xff, 0xfe) }), ProtocolError);
});

test("many frames in one chunk keep their order and their ids", () => {
  const chunks = [];
  for (let id = 1; id <= 50; id++) chunks.push(encodeJsonFrame(FrameType.invoke, id, { id }));

  const frames = new FrameDecoder().push(new Uint8Array(chunks.flatMap((chunk) => [...chunk])));
  assert.equal(frames.length, 50);
  assert.deepEqual(
    frames.map((frame) => frame.id),
    Array.from({ length: 50 }, (_, index) => index + 1),
  );
  assert.deepEqual(decodeJsonPayload(frames[49]), { id: 50 });
});
