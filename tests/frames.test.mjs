/**
 * The shared frame fixture, read on this side too.
 *
 * fixtures/frames.json is byte-identical to the copy the Go store's
 * frame_test.go reads. That file walks every case, builds the frame from
 * `json`, compares it against `payloadHex`/`frameHex`, and checks the type
 * table — so a change to the wire contract turns its suite red, named by
 * case. Before this file existed, nothing on this side read frames.json at
 * all: the README's claim that "a change to the contract turns both suites
 * red at once" was true for fixtures/signing.json (see signer.test.mjs) but
 * not for fixtures/frames.json. This file is what makes it true here too.
 *
 * Three axes, each a positive assertion against the fixture, not just "it
 * parses":
 *   - encode: build the frame from a case's `json` (or, for a case with no
 *     JSON payload, from its `payloadHex` bytes) and require the exact
 *     `frameHex`.
 *   - decode: parse `frameHex` and require the exact `type`, `id`, and
 *     payload back out — including the JSON body, where the case has one.
 *   - the type table: `fixtures/frames.json`'s `types` must match this
 *     package's own `FrameType` constants, name for name and code for code.
 *     This is the axis that caught a real mismatch on the Go side; it is
 *     kept here for the same reason.
 *
 * Against the built package in dist/, the thing that ships.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { encodeFrame, encodeJsonFrame, decodeJsonPayload, FrameDecoder, FrameType } = await import(
  new URL("../dist/protocol/index.mjs", import.meta.url).href
);

const fixture = JSON.parse(readFileSync(new URL("../fixtures/frames.json", import.meta.url), "utf8"));

const hexToBytes = (hex) => new Uint8Array(hex.length ? hex.match(/../g).map((byte) => parseInt(byte, 16)) : []);
const bytesToHex = (bytes) => Buffer.from(bytes).toString("hex");

test("fixture: the case list is not empty, so the assertions below mean something", () => {
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length >= 8, "expected several cases in fixtures/frames.json");
});

test("fixture: the type table matches this package's own FrameType, name for name and code for code", () => {
  assert.deepEqual(fixture.types, FrameType, "fixtures/frames.json.types must match protocol's FrameType exactly");
});

test("fixture: version and header size match this package's constants", async () => {
  const { VERSION, HEADER_BYTES } = await import(new URL("../dist/protocol/index.mjs", import.meta.url).href);
  assert.equal(fixture.version, VERSION);
  assert.equal(fixture.headerBytes, HEADER_BYTES);
});

for (const testCase of fixture.cases) {
  const { name, type, id, json, payloadHex, frameHex } = testCase;

  test(`encode: ${name}`, () => {
    // A case whose `json` is not null is the JSON-carrying kind: build the
    // frame the way a real caller would, from the JSON body, and let
    // encodeJsonFrame do its own JSON.stringify. A case with `json: null`
    // (ping, or a raw non-JSON payload such as "largest id") has no JSON to
    // derive a frame from — its bytes are the payload itself, so the frame
    // is built from payloadHex directly. Either way, the assertion is the
    // fixture's exact frameHex, byte for byte.
    const frame =
      json !== null
        ? encodeJsonFrame(type, id, json)
        : encodeFrame({ type, id, payload: hexToBytes(payloadHex) });

    assert.equal(bytesToHex(frame), frameHex, `${name}: encoded frame did not match frameHex`);
  });

  test(`decode: ${name}`, () => {
    const frames = new FrameDecoder().push(hexToBytes(frameHex));
    assert.equal(frames.length, 1, `${name}: expected exactly one frame out of frameHex`);

    const [decoded] = frames;
    assert.equal(decoded.type, type, `${name}: decoded type`);
    assert.equal(decoded.id, id, `${name}: decoded id`);
    assert.equal(bytesToHex(decoded.payload), payloadHex, `${name}: decoded payload bytes`);

    if (json !== null) {
      assert.deepEqual(decodeJsonPayload(decoded), json, `${name}: decoded JSON body`);
    }
  });
}
