/**
 * What can go wrong, as types rather than strings.
 *
 * A caller has to tell three cases apart without reading a message: the store
 * refused this (nothing will change by retrying), the store could not be
 * reached (retrying is the whole answer), and this connection string is not
 * one we can use at all (a person has to fix it).
 */

/** Everything this package throws. */
export class SapedbError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The connection string is malformed, or carries something the protocol cannot: a field with `:`, a password outside the charset, a port that is not a port. */
export class InvalidConnectionString extends SapedbError {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(`[ecosy/sapedb] ${message}`);
  }
}

/** The signature does not verify: the string was altered, the password has been rotated, or it was issued under another secret. */
export class InvalidSignature extends SapedbError {
  constructor(readonly dbname: string) {
    super(`[ecosy/sapedb] the signature for "${dbname}" does not verify`);
  }
}

/** The store could not be reached, or dropped us. The one error worth retrying. */
export class Unavailable extends SapedbError {
  constructor(
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[ecosy/sapedb] ${message}`, options);
  }
}

/** The store answered, and said no. Retrying changes nothing. */
export class Refused extends SapedbError {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(`[ecosy/sapedb] ${message}`);
  }
}

/** A frame on the wire is not one this version can read. */
export class ProtocolError extends SapedbError {
  constructor(message: string) {
    super(`[ecosy/sapedb] ${message}`);
  }
}
