/**
 * The wire format.
 *
 * ```
 *  0      version   u8     what this frame is written in
 *  1      type      u8     what it is
 *  2..5   id        u32be  which request it belongs to
 *  6..9   length    u32be  bytes of payload
 * 10..    payload
 * ```
 *
 * Three of those cannot be retrofitted, so all three are here from the first
 * commit:
 *
 * - **version**, because evolving a protocol without one means deploying both
 *   sides in the same instant, forever;
 * - **id**, because without it a connection carries one request at a time, and
 *   an app that pools per account rather than per database would need a socket
 *   per request in flight;
 * - **length**, because a stream has no message boundaries of its own.
 */

import { ProtocolError } from "../errors";

export const VERSION = 1;

/** The header, in bytes. */
export const HEADER_BYTES = 10;

/**
 * Bytes of payload a single frame may carry, unless told otherwise.
 * A length field is a promise about an allocation; this is the limit on how
 * much a peer can make us believe.
 */
export const MAX_PAYLOAD = 16 * 1024 * 1024;

/**
 * What a frame is.
 *
 * `hello`/`welcome` fix the account — and, in the bound mode, the database —
 * before anything else is read. `invoke`/`result`/`failure` carry the work.
 * `subscribe`/`event` carry the change log. `ping`/`pong` are the health check
 * the compose file and the doctor both use, so the path they exercise is the
 * one everything else runs on. `elevate` answers the challenge the welcome
 * carried, proving the sender holds the server's own secret; `explore` then
 * carries an access an operator typed rather than the name of a declared
 * operation — refused on a connection that has not proved it, the same as on
 * the store side. `declare` stores an operation on a server that is already
 * running, so adding one no longer means stopping it; it takes the same
 * operator proof, and the same validation an offline `apply` would run.
 */
export const FrameType = Object.freeze({
  hello: 1,
  welcome: 2,
  ping: 3,
  pong: 4,
  invoke: 5,
  result: 6,
  failure: 7,
  subscribe: 8,
  event: 9,
  goodbye: 10,
  elevate: 11,
  explore: 12,
  declare: 13,
});

export type FrameTypeName = keyof typeof FrameType;

const NAME_BY_CODE: ReadonlyMap<number, FrameTypeName> = new Map(
  Object.entries(FrameType).map(([name, code]) => [code, name as FrameTypeName]),
);

/** The name of a frame type, or `undefined` for a code this version does not know. */
export function frameTypeName(code: number): FrameTypeName | undefined {
  return NAME_BY_CODE.get(code);
}

export interface Frame {
  type: number;
  /**
   * Which request this belongs to. A response carries the id of the `invoke`
   * that asked for it; `0` is for frames nobody asked for — an `event` from a
   * subscription, say.
   */
  id: number;
  payload: Uint8Array;
  /** Absent on encode, filled on decode: the version the sender wrote. */
  version?: number;
}

function assertUint32(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new ProtocolError(`${what} must be a 32-bit unsigned integer, got ${value}`);
  }
}

/** One frame, as bytes. */
export function encodeFrame(frame: Frame, options: { maxPayload?: number } = {}): Uint8Array<ArrayBuffer> {
  const maxPayload = options.maxPayload ?? MAX_PAYLOAD;
  const payload = frame.payload ?? new Uint8Array(0);

  if (!Number.isInteger(frame.type) || frame.type < 0 || frame.type > 0xff) {
    throw new ProtocolError(`frame type must be a byte, got ${frame.type}`);
  }
  assertUint32(frame.id, "frame id");
  if (payload.length > maxPayload) {
    throw new ProtocolError(`payload of ${payload.length} bytes is over the ${maxPayload} byte limit`);
  }

  const out = new Uint8Array(HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);

  out[0] = frame.version ?? VERSION;
  out[1] = frame.type;
  view.setUint32(2, frame.id, false);
  view.setUint32(6, payload.length, false);
  out.set(payload, HEADER_BYTES);

  return out;
}

export interface DecoderOptions {
  maxPayload?: number;
  /**
   * Versions this side can read. A frame written in anything else is an error
   * rather than a guess — which is what makes the version byte worth its place.
   */
  versions?: readonly number[];
}

/**
 * Turns a stream of chunks into frames.
 *
 * A socket hands over whatever arrived: half a header, three frames at once,
 * the second half of a payload. Feed each chunk and take the frames that are
 * complete.
 *
 * ```ts
 * const decoder = new FrameDecoder();
 * socket.on("data", (chunk) => {
 *   for (const frame of decoder.push(chunk)) handle(frame);
 * });
 * ```
 */
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);
  private readonly maxPayload: number;
  private readonly versions: ReadonlySet<number>;

  constructor(options: DecoderOptions = {}) {
    this.maxPayload = options.maxPayload ?? MAX_PAYLOAD;
    this.versions = new Set(options.versions ?? [VERSION]);
  }

  /** Bytes held back, waiting for the rest of their frame. */
  get pending(): number {
    return this.buffer.length;
  }

  /**
   * Every frame this chunk completed, in order.
   *
   * @throws ProtocolError on a version this side cannot read, or a length over
   * the limit. Both leave the decoder unusable on purpose: a stream that said
   * something impossible cannot be resynchronised, only dropped.
   */
  push(chunk: Uint8Array): Frame[] {
    if (chunk.length) {
      const joined = new Uint8Array(this.buffer.length + chunk.length);
      joined.set(this.buffer, 0);
      joined.set(chunk, this.buffer.length);
      this.buffer = joined;
    }

    const frames: Frame[] = [];

    for (;;) {
      if (this.buffer.length < HEADER_BYTES) break;

      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const version = this.buffer[0];
      const type = this.buffer[1];
      const id = view.getUint32(2, false);
      const length = view.getUint32(6, false);

      if (!this.versions.has(version)) {
        throw new ProtocolError(`frame version ${version} is not one this side reads (${[...this.versions].join(", ")})`);
      }
      if (length > this.maxPayload) {
        throw new ProtocolError(`a frame declared ${length} bytes, over the ${this.maxPayload} byte limit`);
      }
      if (this.buffer.length < HEADER_BYTES + length) break;

      frames.push({
        version,
        type,
        id,
        payload: this.buffer.slice(HEADER_BYTES, HEADER_BYTES + length),
      });

      this.buffer = this.buffer.slice(HEADER_BYTES + length);
    }

    return frames;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** A frame whose payload is JSON — every control frame. */
export function encodeJsonFrame(type: number, id: number, body: unknown, options?: { maxPayload?: number }): Uint8Array<ArrayBuffer> {
  return encodeFrame({ type, id, payload: encoder.encode(JSON.stringify(body ?? null)) }, options);
}

/**
 * The JSON a frame carries.
 *
 * @throws ProtocolError when the payload is not valid UTF-8 JSON — a peer that
 * sends that is broken, not merely unlucky.
 */
export function decodeJsonPayload<Body = unknown>(frame: Frame): Body {
  try {
    return JSON.parse(frame.payload.length === 0 ? "null" : decoder.decode(frame.payload)) as Body;
  } catch (error) {
    throw new ProtocolError(
      `frame ${frameTypeName(frame.type) ?? frame.type} did not carry JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
