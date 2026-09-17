/**
 * Time-ordered ids.
 *
 * 48 bits of milliseconds, then 80 bits of randomness, in Crockford base32 —
 * the ULID layout. Two properties earn it its place: ids sort by the time they
 * were made, so "newest first" is a walk backwards over the primary key and
 * needs no index of its own; and one made on a client cannot collide with one
 * made anywhere else, so a write can carry its own id before the store has
 * seen it.
 *
 * @internal
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = -1;
let lastRandom: Uint8Array = new Uint8Array(10);

function encodeTime(ms: number): string {
  let out = "";
  let value = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  /* 80 bits into 16 base32 characters, five at a time, most significant first,
     so the text sorts the way the bytes do. Done with a small bit buffer rather
     than a BigInt: this package builds for older targets too. */
  let out = "";
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }

  return out;
}

/** Adds one to the random part, so two ids made in the same millisecond still sort in order. */
function increment(bytes: Uint8Array): Uint8Array {
  const next = bytes.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] < 255) {
      next[i]++;
      return next;
    }
    next[i] = 0;
  }
  // Every byte was 0xff: astronomically unlikely, and a fresh draw is correct.
  return crypto.getRandomValues(new Uint8Array(10));
}

/** A new id, sorting after every id this process made before it. */
export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    lastRandom = increment(lastRandom);
  } else {
    lastTime = now;
    lastRandom = crypto.getRandomValues(new Uint8Array(10));
  }

  return encodeTime(now) + encodeRandom(lastRandom);
}
