/**
 * The connection string.
 *
 * ```
 * sapedb://<account_id>:<password>@<host>:<port>/<dbname>?sig=<hex>
 *        └ the account         └ where            └ the database
 * ```
 *
 * Shaped after `postgres://` on purpose: the account is the identity, the
 * database is the path, and both are fixed before a command is read. The whole
 * string is the credential — nothing in it is individually safe to publish.
 *
 * ```ts
 * import { parseConnectionString, verifyConnectionString } from "@ecosy/sapedb/connection";
 *
 * const target = parseConnectionString(process.env.DATABASE_URL!);
 * if (!(await verifyConnectionString(target, { secret }))) throw new Error("rotated");
 * ```
 */

import { InvalidConnectionString } from "../errors";
import { isValidPassword, verify, type SignOptions } from "../signer";

export const SCHEME = "sapedb:";
export const DEFAULT_PORT = 7433;

/** A connection string, taken apart. */
export interface ConnectionTarget {
  accountId: string;
  /** The rotation key. Changing it invalidates every string issued before. */
  password: string;
  host: string;
  port: number;
  dbname: string;
  /** Lower-case hex. Proof the issuer made this exact string; not secret on its own. */
  sig: string;
}

function decode(value: string, field: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new InvalidConnectionString(`${field} is not valid percent-encoding`, field);
  }
}

function assertField(value: string, field: string): string {
  if (value.length === 0) throw new InvalidConnectionString(`${field} is empty`, field);
  if (value.includes(":")) throw new InvalidConnectionString(`${field} must not contain ":"`, field);
  return value;
}

/**
 * Takes a connection string apart, checking everything that can be checked
 * without the secret.
 *
 * @throws InvalidConnectionString naming the field at fault — this is a string
 * a person pasted, so the error has to say which part is wrong.
 */
export function parseConnectionString(value: string): ConnectionTarget {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidConnectionString("a connection string is required");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    /* A string a person pasted deserves better than "not a URL". The port is
       the field that fails here most often, and `URL` refuses it before it
       parses anything else, so name it before giving up. */
    const port = /@[^/?#]*:(\d+)(?:[/?#]|$)/.exec(value)?.[1];
    if (port !== undefined && Number(port) > 65535) {
      throw new InvalidConnectionString(`"${port}" is not a port`, "port");
    }
    throw new InvalidConnectionString(`"${value.slice(0, 24)}…" is not a URL`);
  }

  if (url.protocol !== SCHEME) {
    throw new InvalidConnectionString(`the scheme must be ${SCHEME}//, not ${url.protocol}//`, "scheme");
  }
  if (!url.username) throw new InvalidConnectionString("the account is missing before the ':'", "account_id");
  if (!url.password) throw new InvalidConnectionString("the password is missing after the ':'", "password");
  if (!url.hostname) throw new InvalidConnectionString("the host is missing", "host");

  const accountId = assertField(decode(url.username, "account_id"), "account_id");
  const password = decode(url.password, "password");

  if (!isValidPassword(password)) {
    throw new InvalidConnectionString("the password must be 16 to 128 characters of A-Z a-z 0-9 . _ ~ -", "password");
  }

  const dbname = assertField(decode(url.pathname.replace(/^\//, ""), "dbname"), "dbname");
  if (dbname.includes("/")) throw new InvalidConnectionString("a connection names one database", "dbname");

  const port = url.port === "" ? DEFAULT_PORT : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidConnectionString(`"${url.port}" is not a port`, "port");
  }

  const sig = url.searchParams.get("sig") ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(sig)) {
    throw new InvalidConnectionString("sig must be 64 hex characters", "sig");
  }

  return { accountId, password, host: url.hostname, port, dbname, sig: sig.toLowerCase() };
}

/**
 * The string again, from its parts. Round-trips with {@link parseConnectionString}.
 *
 * The password is percent-encoded even though its charset needs no encoding —
 * so that a string built here still parses if the charset is ever widened.
 */
export function formatConnectionString(target: ConnectionTarget): string {
  const { accountId, password, host, port, dbname, sig } = target;

  assertField(accountId, "account_id");
  assertField(dbname, "dbname");
  if (!isValidPassword(password)) {
    throw new InvalidConnectionString("the password must be 16 to 128 characters of A-Z a-z 0-9 . _ ~ -", "password");
  }
  if (!/^[0-9a-f]{64}$/.test(sig)) throw new InvalidConnectionString("sig must be 64 lower-case hex characters", "sig");

  const authority = `${encodeURIComponent(accountId)}:${encodeURIComponent(password)}@${host}:${port}`;
  return `sapedb://${authority}/${encodeURIComponent(dbname)}?sig=${sig}`;
}

/**
 * Whether the signature in a connection string is the one these parts have
 * under this secret — the only check the store itself makes, since it holds no
 * password for anyone.
 *
 * Takes a string or an already-parsed target. Never throws for a bad
 * signature: that is an answer, not an error.
 */
export async function verifyConnectionString(target: ConnectionTarget | string, options: SignOptions): Promise<boolean> {
  const parsed = typeof target === "string" ? parseConnectionString(target) : target;

  return verify(parsed.sig, { accountId: parsed.accountId, password: parsed.password, dbname: parsed.dbname }, options);
}

/** What a log or an error message may show: everything but the password and the signature. */
export function redact(target: ConnectionTarget | string): string {
  const parsed = typeof target === "string" ? parseConnectionString(target) : target;
  return `sapedb://${parsed.accountId}:***@${parsed.host}:${parsed.port}/${parsed.dbname}`;
}
