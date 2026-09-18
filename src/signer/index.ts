/**
 * The signing contract: the one thing the TypeScript app and the Go store have
 * to agree on byte for byte, where disagreement is silent.
 *
 * ```ts
 * import { sign, verify } from "@ecosy/sapedb/signer";
 *
 * const sig = await sign({ accountId, password, dbname }, { secret: process.env.SAPEDB_SECRET! });
 * ```
 *
 * Web Crypto only, so this runs on Node, on the edge and in Workers alike.
 */

const encoder = new TextEncoder();

/** What a signature covers: the three fields of an `sapedb://` string that identify a connection. */
export interface ConnectionParts {
  /**
   * The registered account — the product or service this string belongs to.
   * The tenant boundary: a connection never reaches across accounts, and a
   * database name only has to be unique within one.
   */
  accountId: string;
  /** The rotation key. Changing it invalidates every signature issued before. */
  password: string;
  /** The database, unique within the account. */
  dbname: string;
}

export interface SignOptions {
  /**
   * The shared secret itself. Where it comes from is the app's business —
   * `SAPEDB_SECRET` is only a suggested name; nothing here reads the environment.
   */
  secret: string;
  /**
   * How the signing key is made, and the one setting both sides must agree on:
   *
   * - a **string** (the default) derives it — `HMAC-SHA256(secret, label)` — so
   *   a signature cannot pass as one from another subsystem sharing the secret;
   * - **`null`** signs with the secret directly, the plainer form.
   *
   * Default {@link DEFAULT_LABEL}.
   */
  label?: string | null;
}

/**
 * What a password may be.
 *
 * Deliberately narrow, and the narrowness is the feature. Unicode has more than
 * one way to write the same password — macOS composes, Windows decomposes, and
 * copy-paste converts between them — so the same password typed on two machines
 * is two different byte strings and two different signatures, with nothing in a
 * log to explain it. This charset has one encoding per password, so neither
 * side has to normalise and neither side can normalise differently.
 *
 * It also excludes `:`, which is what makes `user:password:project` unambiguous
 * without length prefixing.
 */
export const PASSWORD_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;

export const DEFAULT_LABEL = "ecosy/sapedb:connection:v1";

/** Whether `password` is one this protocol can carry. */
export function isValidPassword(password: unknown): password is string {
  return typeof password === "string" && PASSWORD_PATTERN.test(password);
}

/**
 * Throws unless `password` matches {@link PASSWORD_PATTERN}.
 *
 * @throws TypeError naming what is wrong, for a form to show.
 */
export function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== "string") {
    throw new TypeError("[ecosy/sapedb] password must be a string");
  }
  if (password.length < 16 || password.length > 128) {
    throw new TypeError(`[ecosy/sapedb] password must be 16 to 128 characters, got ${password.length}`);
  }
  if (!PASSWORD_PATTERN.test(password)) {
    throw new TypeError("[ecosy/sapedb] password may only use A-Z a-z 0-9 . _ ~ -");
  }
}

/* A field carrying the delimiter would let two different triples produce one
   signature: HMAC(K, "ab" + ":" + "c") and HMAC(K, "a" + ":" + "bc") are the
   same bytes. The password is kept clear of it by its charset; the two ids are
   RunSnip's own, and checked here rather than trusted. */
function assertField(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`[ecosy/sapedb] ${name} must be a non-empty string`);
  }
  if (value.includes(":")) {
    throw new TypeError(`[ecosy/sapedb] ${name} must not contain ":"`);
  }
}

const keys = new Map<string, Promise<CryptoKey>>();

/** The key a signature is made with: derived under a label, or the secret itself. */
function signingKey(secret: string, label: string | null): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new TypeError("[ecosy/sapedb] secret must be a non-empty string");
  }

  const id = JSON.stringify([label === null ? "direct" : "derived", label, secret]);
  let pending = keys.get(id);

  if (!pending) {
    pending = (async () => {
      const usages: KeyUsage[] = label === null ? ["sign", "verify"] : ["sign"];
      const root = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);

      // The plain form: the secret is the key.
      if (label === null) return root;

      const derived = await crypto.subtle.sign("HMAC", root, encoder.encode(label));
      return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    })();
    keys.set(id, pending);
  }

  return pending;
}

/** The exact bytes signed: `account_id ":" password ":" dbname`, UTF-8, unnormalised. */
export function signedMessage(parts: ConnectionParts): string {
  assertField(parts?.accountId, "account_id");
  assertPassword(parts.password);
  assertField(parts.dbname, "dbname");

  return `${parts.accountId}:${parts.password}:${parts.dbname}`;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]*$/.test(text) || text.length % 2 !== 0) return null;

  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * The `sig` of a connection string: lower-case hex, 64 characters.
 *
 * @throws TypeError when a field is missing, carries `:`, or the password is
 * outside {@link PASSWORD_PATTERN}.
 */
export async function sign(parts: ConnectionParts, options: SignOptions): Promise<string> {
  const key = await signingKey(options.secret, options.label === undefined ? DEFAULT_LABEL : options.label);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(signedMessage(parts))));
}

/**
 * Whether `signature` is the one these parts have under this secret.
 *
 * Never throws for input reasons — a malformed signature, an odd charset, a
 * password that could not have been issued are all `false`. The comparison is
 * constant time.
 */
export async function verify(signature: unknown, parts: ConnectionParts, options: SignOptions): Promise<boolean> {
  if (typeof signature !== "string") return false;

  const bytes = fromHex(signature.toLowerCase());
  if (!bytes || bytes.length !== 32) return false;

  let message: string;
  try {
    message = signedMessage(parts);
  } catch {
    return false;
  }

  const key = await signingKey(options.secret, options.label === undefined ? DEFAULT_LABEL : options.label);
  return crypto.subtle.verify("HMAC", key, bytes, encoder.encode(message));
}
