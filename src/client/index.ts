/**
 * The driver: connections, and the calls that travel over them.
 *
 * ```ts
 * import { Client } from "@ecosy/sapedb/client";
 *
 * const AppStore = Client({ transport, storageKey: "app" });
 * const store = new AppStore();
 * const rows = await store.invoke(process.env.DATABASE_URL!, "orders.list", { limit: 20 });
 * ```
 *
 * That call names an operation as a string and passes whatever it likes, and
 * nothing notices a typo until the store answers. `sapedb-types` turns a
 * `schema.json` into a `.d.ts`, and {@link Client}`<Schema>` takes it, so the
 * same typo is a compile error instead. Same runtime, same frames — see
 * `@ecosy/sapedb/types`.
 *
 * Three things it is built around, each of them a decision rather than a
 * default:
 *
 * - **Nothing is opened at import or at boot.** The first call opens a
 *   connection. A store that cannot be reached must fail the calls that need
 *   it, not the process that happens to import this.
 * - **The account is the connection.** One socket serves every database of an
 *   account; nothing on it can reach another account's.
 * - **A write carries its own id.** A retry after a dropped connection sends
 *   the same id, so the store replays its answer instead of doing the work
 *   twice. Reads may be retried freely; writes are never retried without it.
 */

import { parseConnectionString, redact, type ConnectionTarget } from "../connection";
import { Refused, SapedbError, Unavailable } from "../errors";
import { ulid } from "../internal/id";
import { globalState } from "../internal/global-state";
import { operate } from "../signer";
import {
  decodeJsonPayload,
  encodeJsonFrame,
  FrameType,
  type Frame,
} from "../protocol";

/** Console-shaped; only `warn` is used. */
export interface ClientLogger {
  warn(...args: unknown[]): void;
}

/** A live connection to a store, as the driver needs it. Sockets, or something in a test. */
export interface Connection {
  send(bytes: Uint8Array): void;
  /** Every frame the store sends. */
  onFrame(handler: (frame: Frame) => void): void;
  /** Called once when the connection ends, for any reason. */
  onClose(handler: (reason?: unknown) => void): void;
  close(): void;
}

/** Opens connections. Node TLS, a Worker socket, or a double. */
export interface Transport {
  connect(target: ConnectionTarget): Promise<Connection>;
}

export interface ClientOptions {
  transport: Transport;
  /**
   * How a connection is scoped.
   *
   * - `"account"` (the default): one connection serves every database of an
   *   account, and each call names its database and carries its signature.
   *   A pool of a few sockets then serves any number of databases.
   * - `"bound"`: the database is fixed at the handshake and calls name none —
   *   the stricter shape, for a client that is not the app itself.
   */
  mode?: "account" | "bound";
  /** Milliseconds to wait for a connection. Default 5000. */
  connectTimeout?: number;
  /** Milliseconds to wait for an answer. Default 15000. */
  requestTimeout?: number;
  /** Milliseconds a connection may sit unused before it is closed. Default 60000. */
  idleTimeout?: number;
  /** Milliseconds between pings on an idle connection. `0` turns them off. Default 20000. */
  keepAlive?: number;
  breaker?: {
    /** Consecutive failures to open a connection before calls fail fast. Default 3. */
    failures?: number;
    /** Milliseconds to fail fast for. Default 5000. */
    cooldown?: number;
  };
  logger?: ClientLogger;
  /** Shares the pool on `globalThis` under this name, for hosts that evaluate a module more than once. */
  storageKey?: string;
}

export interface InvokeOptions {
  /**
   * A call that changes something. It is given an id, and a retry after a
   * dropped connection sends the same one — which is what lets the store tell
   * "do this again" from "you already did this, tell me what happened".
   */
  write?: boolean;
  /** Reuse an id from an earlier attempt, when the retry is the caller's own. */
  writeId?: string;
  /** Overrides {@link ClientOptions.requestTimeout}. */
  timeout?: number;
  /**
   * Runs this exact declared version instead of the latest one.
   *
   * Only meaningful once a name has been declared more than once — by
   * {@link ClientToken.declare}, or by a second `sapedb apply` — since that is
   * the only way an older version outlives the name still pointing at it.
   * Left out (or `0`, which means the same thing), this is the call every
   * caller already knows: whatever the name currently resolves to. The field
   * is never sent on the wire when it is `0`, matching the store's own
   * `omitempty` — an explicit zero would be a difference with no meaning.
   */
  version?: number;
  /**
   * The scope grant to present with this call, for an operation declared with
   * {@link Operation.scopes}.
   *
   * This is not a request for permissions — a caller cannot mint one, for the
   * same reason it cannot mint a connection string's own `sig`: `sig` is an
   * HMAC made with the server's own secret over the account, the database,
   * the scopes, the expiry and the serial together, minted by whoever issues
   * connection strings and handed to the caller alongside the string itself
   * (the server's `Server.Grant`, on the Go side that holds the secret;
   * nothing here can do that). Presenting an edited `scopes`, `exp` or
   * `serial` without a matching `sig` fails to verify, the same as presenting
   * no grant at all — a caller cannot widen what it holds, or outlive it, by
   * rewriting a field.
   *
   * Left out, this call presents no scopes, which is what every call did
   * before grants existed and is what every call still does that never sets
   * this: an operation declaring `scopes` refuses it with `not_allowed`,
   * naming the scope it needed. A `grant` whose `sig` does not verify — wrong
   * secret, an edited field, a grant minted for a different account or
   * database — is refused with `grant` instead, before `not_allowed` is ever
   * reached: a bad credential is a different problem from a missing
   * permission. A grant whose signature verifies but whose `exp` has passed
   * is refused with `grant_expired` — a different code again, because
   * refreshing the grant and giving up are different answers and a caller
   * needs to tell them apart without reading prose.
   */
  grant?: Grant;
}

/**
 * A set of scopes, an expiry and a serial, and the proof that the server's
 * own secret vouches for all four together — presented with an
 * {@link InvokeOptions.grant}. Mirrors the server's `grant` (see
 * `internal/server/server.go`) and the signature `signing.Grants` checks
 * (see `internal/signing/signing.go`).
 *
 * Every field is carried, none is computed. This package cannot make `sig`,
 * and cannot make an `exp` or a `serial` that a `sig` would cover — they
 * arrive together from whoever issued the connection string, and this type is
 * the envelope they travel in.
 */
export interface Grant {
  /** The scopes this grant claims. Order and repetition do not matter to the server, but are sent exactly as given. */
  scopes: string[];
  /**
   * When this grant stops being one, as whole Unix seconds UTC — the same
   * unit `signing.GrantMessage` signs and `signing.Grants` checks against its
   * own clock, with no allowance for skew. Mandatory: a grant with no expiry
   * is not a smaller grant, it is the thing this field exists to abolish, and
   * leaving it out sends `0`, which never verifies.
   */
  exp: number;
  /**
   * Names this particular grant, for a future revocation list to name.
   * Carried and signed; nothing on the server verifies it *against* anything
   * yet — but it is still mandatory, because a grant issued after this field
   * existed was signed over it, and leaving it out sends `""`, which does not
   * match that signature.
   */
  serial: string;
  /** Lower-case hex HMAC over the label, the account, the database, the scope list, `exp` and `serial`, under the server's `sapedb/scopes:v2` key. Not something this package can produce — see {@link InvokeOptions.grant}. */
  sig: string;
}

export interface SubscribeOptions {
  /** The first entry to receive. A replica restored from a dump starts at the dump's entry plus one. */
  from: number;
  /** Called when the feed ends: the connection went, or the store said it could no longer serve it. */
  onEnd?: (reason: unknown) => void;
}

/** One change, as the store recorded it. */
export interface Change {
  lsn: number;
  at?: number;
  kind: string;
  collection?: string;
  key?: unknown;
  document?: Record<string, unknown>;
  by?: { operation?: string; version?: number; actor?: string; write_id?: string };
}

export interface Subscription {
  /** Where the feed started, and where the store had reached when it did. */
  from: number;
  latest: number;
  oldest: number;
  /** Stops the feed. The connection stays for whatever else is using it. */
  close(): void;
}

export interface PoolStats {
  /** Open connections, by pool key. */
  connections: number;
  /** Calls sent and not yet answered. */
  inFlight: number;
  /** Accounts the breaker is failing fast for. */
  tripped: string[];
}

export interface ClientToken {
  /** Calls a declared operation. The target is a connection string, or one already parsed. */
  invoke<Result = unknown>(
    target: string | ConnectionTarget,
    command: string,
    args?: Record<string, unknown>,
    options?: InvokeOptions,
  ): Promise<Result>;
  /**
   * Follows the change log from an entry onwards.
   *
   * Every change the store makes, in order, once — the same log a replica
   * replays. What it is not is a promise that the store waits: entries are
   * trimmed to whatever retention it was given, and a subscriber that falls
   * behind that is ended with `too_far_behind` rather than quietly resumed
   * from wherever the log now starts. Being told is what makes it possible to
   * go and fetch a dump; being skipped ahead silently is not.
   */
  subscribe(
    target: string | ConnectionTarget,
    options: SubscribeOptions,
    onChange: (change: Change) => void,
  ): Promise<Subscription>;
  /** Round trip to the store — the same path everything else uses, so a health check proves the real thing. */
  ping(target: string | ConnectionTarget): Promise<number>;
  /**
   * Proves this connection holds the server's own secret, over the challenge
   * the welcome just issued for it. Marks the connection as an operator on
   * the store side; {@link explore} is refused on one that has not done this.
   *
   * Operating a database is a different permission from using one, and
   * nothing in a connection string says which you hold — this is the proof
   * instead, good for this one connection only. It does not survive a
   * reconnect: a connection the pool re-opens after this one drops gets a
   * fresh challenge and starts as no more an operator than a brand new one,
   * and calling this again is the only way back.
   */
  elevate(target: string | ConnectionTarget, secret: string, options?: { timeout?: number }): Promise<Elevated>;
  /**
   * Runs a typed access — a `get`, a `scan` or a `count` an operator names
   * directly — or asks what the database holds, on a connection that has
   * called {@link elevate}. Nothing here writes: that is a different frame
   * this driver does not send, on purpose.
   */
  explore<Row = unknown>(
    target: string | ConnectionTarget,
    request: ExploreRequest,
    options?: { timeout?: number },
  ): Promise<Explored<Row>>;
  /**
   * Stores an operation on a database whose server is already running, on a
   * connection that has called {@link elevate}. Not operating this connection
   * gets the same refusal as {@link explore}: `not_operator`.
   *
   * This is the same declaration `sapedb apply` writes offline, run through
   * `store.DeclareOperation` on the server — not a second, looser copy of the
   * rules. A shape it refuses offline (a `scan` with no `limit`, say) it
   * refuses here too, in the store's own words. `explore`'s typed `scan`
   * looks like the same shape and is not held to this: `explore` silently
   * fills in a limit before it checks anything, because an operator who did
   * not say is not asking for everything. A declaration is a promise about
   * cost that somebody has to keep, so nothing here fills in what was left
   * out.
   *
   * Declaring a name that is already declared writes a **new version** and
   * leaves the old one exactly as it was — this never overwrites. There is
   * also no "nothing changed, so nothing happened": calling this twice with
   * byte-for-byte the same operation still produces two versions. A caller
   * that declares from a deploy step on every run, rather than once when the
   * shape actually changes, grows a version for every deploy forever. Read
   * the version back off what this resolves to when a specific one might
   * need calling again later — see {@link InvokeOptions.version}.
   */
  declare(target: string | ConnectionTarget, operation: Operation, options?: { timeout?: number }): Promise<Operation>;
  /**
   * Declares a collection on a database whose server is already running, on a
   * connection that has called {@link elevate}. Not operating this connection
   * gets the same refusal as {@link explore} and {@link declare}:
   * `not_operator`.
   *
   * This is {@link declare}'s other half, and it arrived later because the two
   * answer "the name is already declared" differently. An operation is
   * versioned — a caller is built against one, so a redeclaration must never
   * move the ground under it — but a collection has no version to give: it is
   * where the documents physically are, and there is one of those. So
   * establishing a name that already exists brings THAT collection up to date
   * **in place**, not a second one: indexes and rollups it names are built
   * over the documents already stored, or kept as they were; ones it leaves
   * out are dropped, entries and all; and what cannot be changed in place —
   * the primary key, how the collection is divided, an index that keeps its
   * name and changes its shape — is refused, in the store's own words, rather
   * than done quietly or as a second collection nobody asked for.
   *
   * This runs the same `store.Declare` that `sapedb apply` calls offline, over
   * the wire — not a second, looser copy of the rules. A shape it refuses
   * offline it refuses here too, verbatim.
   *
   * The {@link CollectionSpec} handed back is what actually took effect, read
   * off the collection rather than echoed: it carries the ids the store
   * assigned (or kept, for a collection this reuses), which is what makes it
   * worth reading even when the declaration was sent before — that id is what
   * says whether it is one collection or two.
   */
  establish(
    target: string | ConnectionTarget,
    spec: CollectionDeclaration,
    options?: { timeout?: number },
  ): Promise<CollectionSpec>;
  /** Closes every connection. Calls in flight are rejected. */
  close(): Promise<void>;
  stats(): PoolStats;
}

export type ClientClass = new () => ClientToken;

/**
 * What the store answers a call with, whole.
 *
 * This is the envelope every action comes back in, not the rows themselves:
 * `rows` is absent for a `get` that found nothing and for everything that
 * returns a number or a key rather than documents, which is why reading it
 * makes the caller say what happens when there was nothing.
 */
export interface InvokeResult<Row = unknown> {
  operation: string;
  version: number;
  /** Absent rather than empty when the read found nothing. */
  rows?: Row[];
  count?: number;
  /** The primary key a write landed on. Its type is the collection's, which the caller knows and the wire does not. */
  key?: unknown;
  changed?: number;
  /** The read stopped at its declared limit and there was more. */
  truncated?: boolean;
  /** The log entry a repeated write id had already produced. Nothing was written again. */
  repeated?: number;
}

/* ---- the operator shell: elevate, and explore's typed accesses ----
 *
 * Every field below is checked against the store's own struct tags in
 * internal/store and internal/server, not guessed from the rest of this
 * file's naming — a field the store marks `omitempty` is optional here, one
 * it does not is required here even where it is usually empty, and a wire
 * key that breaks this file's own naming habits (snake_case, or no tag at
 * all) is kept exactly as the store spells it. Getting one of these
 * backwards does not fail a build; it fails silently, in whatever call
 * happens to hit the field first. See tests/server.test.mjs for the cases
 * this was checked against a real daemon.
 */

/** One end of a scan an operator names directly, without a declared operation to hold it.
 *
 * Mirrors `store.Bound` on the Go side — the one type in this whole exchange
 * with no `json` tag on either field at all, so `encoding/json` would marshal
 * it as `{"Values":...,"Exclusive":...}`, capitalized, if the store ever sent
 * one back. It never does; `Bound` is only ever read, as the `from`/`to` of
 * an {@link Access}. That is what makes `values`/`exclusive` here safe rather
 * than merely convenient: `encoding/json`'s decoder falls back to a
 * case-insensitive match against the exported field name when no tag claims
 * it first, so lower-case, matching everything else `explore` carries, still
 * reaches `Bound.Values` and `Bound.Exclusive` intact. Proven against the
 * real daemon in tests/server.test.mjs, not assumed — and worth re-checking
 * the day `store.Bound` gains a `json` tag or the store starts emitting one.
 */
export interface Bound {
  values: unknown[];
  exclusive?: boolean;
}

/**
 * One thing an operator asks to look at — the parameters of a declared
 * operation, arriving now instead of having been declared. Mirrors
 * `store.Access`.
 */
export interface Access {
  /** `"get"`, `"scan"` or `"count"`. Nothing writes. */
  kind: "get" | "scan" | "count";
  collection: string;
  /** Which document, for a `get`. */
  key?: unknown;
  /** Which index a `scan` or `count` walks. Empty is the clustered one. */
  index?: string;
  from?: Bound;
  to?: Bound;
  limit?: number;
  /** Which fields to show. */
  projection?: string[];
}

/**
 * Where a value in a declared operation comes from: an argument of the call,
 * a constant written into the declaration, or what an earlier batch step
 * produced. Exactly one of the five. Mirrors `store.Term`.
 */
export interface Term {
  arg?: string;
  value?: unknown;
  /** Distinguishes a declared value of `null` from no value at all, which JSON alone cannot. */
  constant?: boolean;
  step?: string;
  field?: string;
}

/**
 * One end of a declared scan: values for the first fields of the index, and
 * whether that point is included. Mirrors `store.Endpoint`.
 *
 * `terms` carries no `omitempty` on the Go side, so a `from`/`to` a draft
 * came back with always has the key, even as `[]` for a stretch with no
 * bound at that end — never absent, so never worth an `?` here.
 */
export interface Endpoint {
  terms: Term[];
  exclusive?: boolean;
}

/** One declared argument of an operation. Mirrors `store.Parameter`. */
export interface Parameter {
  name: string;
  type: string;
  required?: boolean;
  default?: unknown;
}

/** One thing a batch step's document must already satisfy. Mirrors `store.Condition`. */
export interface Condition {
  path: string;
  /** The value the field must have. Absent (on the wire) says it must not be there at all. Exactly one of the two. */
  equals?: Term;
  absent?: boolean;
}

/**
 * One part of a batch, in the order it runs. Mirrors `store.Step`.
 *
 * A step either touches a collection — `action`/`collection`, with the
 * fields under them — or calls an already-declared operation — `operation`,
 * `version` and `with`. Never both; declaring a step that writes both shapes
 * is refused when the operation is declared, not when it runs.
 *
 * What composing an operation buys, and what it does not:
 *
 * - **`version` must be greater than zero.** There is no "run whichever
 *   version is newest": a reference that followed the latest would make the
 *   cost this operation declares change the moment somebody else redeclared
 *   the callee, silently. Pinning a version is also what makes recursion
 *   impossible to write down — a version is only ever handed out going up,
 *   and a pinned reference only resolves to one that already exists, so the
 *   reference graph is a DAG by construction.
 * - **The readable ceiling, at any depth, is the composed operation's own
 *   declared `limit`** — never a product of what its steps call, and never a
 *   number the caller has to add up. The store enforces this when the
 *   operation is declared: the ceilings of the steps must sum to no more
 *   than the parent's `limit`.
 * - **A step runs exactly once.** A `with` term may take a value from an
 *   earlier step's key only when that step's own ceiling is 1 — a step
 *   cannot take a value from a leg that may hand back more than one row,
 *   which is what keeps this from becoming a loop written in JSON.
 * - **`InvokeResult.rows` stays flat**, in step order, with no label saying
 *   which step a row came from — the same shape a batch of plain steps has
 *   always answered. A composed operation of several legs does not change
 *   that; the caller who needs to tell them apart has to know the shape of
 *   each leg's answer ahead of time.
 * - **This is not sold as faster.** What composing buys is measured in
 *   round trips saved — a count read off the declaration, K − 1 for a batch
 *   of K steps — not a duration: on loopback the difference between a
 *   composed call and the flat calls it replaces was 0.099–0.131 ms, the
 *   same size as the noise between two runs of the same measurement.
 *   Nobody has measured it across a real network. What it does buy is
 *   atomicity: the composed answer is one transaction and therefore one
 *   state, where two separate calls could straddle a write landing between
 *   them.
 */
export interface Step {
  name?: string;
  action?: string;
  collection?: string;
  key?: Term;
  document?: Record<string, Term>;
  set?: Record<string, Term>;
  /** Whether the document this step names must, or must not, already be there. Absent (on the wire) means not checked. */
  exists?: boolean;
  require?: Condition[];
  /** The name of an already-declared operation this step calls, instead of touching a collection directly. */
  operation?: string;
  /**
   * Which declared version of `operation` this step runs — pinned, never
   * the latest. Required (and must be greater than zero) whenever
   * `operation` is set; `0` or absent is only ever meant for a step that
   * touches a collection instead.
   */
  version?: number;
  /** The arguments handed to `operation`, by the names its own declaration takes them under. */
  with?: Record<string, Term>;
}

/**
 * A declaration: everything about a call except its arguments. What
 * `explore` hands back as the draft an access would have to be declared as,
 * and what a database's catalogue lists as already declared. Mirrors
 * `store.Operation`.
 */
export interface Operation {
  name: string;
  collection: string;
  action: string;
  input?: Parameter[];
  /** Which document, for the actions that work on exactly one. */
  key?: Term;
  /** Which declared total to read, for an operation that reads one. */
  rollup?: string;
  index?: string;
  from?: Endpoint;
  to?: Endpoint;
  direction?: Term;
  /** What an insert or a put writes. */
  document?: Record<string, Term>;
  /** What an update changes. */
  set?: Record<string, Term>;
  steps?: Step[];
  /** The fields a read returns. Empty returns the whole document. */
  projection?: string[];
  /** The most rows a scan may return. Present on every declared scan. */
  limit?: number;
  /** What a caller must hold. Checked fail-closed. */
  scopes?: string[];
  version?: number;
}

/** What a field of a document's index key is. Mirrors `store.Field`. */
export interface FieldSpec {
  path: string;
  type: string;
  descending?: boolean;
  /**
   * What an index does with a document that has no value here: `"skip"`,
   * `"first"` or `"last"`. Carries no `omitempty` on the Go side — a default
   * here would silently decide which documents a range query returns, so the
   * store never lets it go unsaid, and this is never optional either.
   */
  missing: "skip" | "first" | "last";
}

/** One declared index. Mirrors `store.Index`. */
export interface IndexSpec {
  name: string;
  fields: FieldSpec[];
  unique?: boolean;
  /** The one field whose array elements are indexed separately, if any. */
  array?: string;
  /** Carried in the index entry so a read that wants only these fields never touches the document. */
  include?: string[];
  id: number;
}

/** The primary key: where it lives in the document and what it is. Mirrors `store.Key`. */
export interface PrimaryKey {
  path: string;
  type: string;
  /** `"ulid"` to have one made when the document does not carry it, or absent to require the writer to supply it. */
  auto?: string;
}

/** How a collection is divided into files. Mirrors `store.Partition`. */
export interface Partition {
  by: "time" | "hash";
  /** Time partitions only. */
  every?: "day" | "month" | "year";
  /** Time partitions only. Absent (on the wire) keeps everything. */
  keep?: number;
  /** Hash partitions only. */
  into?: number;
}

/** A total kept up to date by every write, in the same transaction as the write. Mirrors `store.Rollup`. */
export interface RollupSpec {
  name: string;
  group?: FieldSpec[];
  count?: boolean;
  sum?: string[];
  id: number;
}

/**
 * An index as {@link ClientToken.establish} sends it — everything
 * {@link IndexSpec} carries except `id`. An index being established has no id
 * to give: the store hands out a fresh one for an index that is new, and
 * keeps the one an index of the same name already had — either way, an id a
 * caller sent would be looked at by nobody. Mirrors what `store.Declare`
 * actually reads off an incoming `store.Index` for a declaration, not a
 * narrower type this driver invented on top of it.
 */
export type IndexDeclaration = Omit<IndexSpec, "id">;

/** A rollup as {@link ClientToken.establish} sends it. Same reasoning as {@link IndexDeclaration}: `id` is the store's to assign, never the caller's to propose. */
export type RollupDeclaration = Omit<RollupSpec, "id">;

/**
 * A collection as {@link ClientToken.establish} sends it — everything
 * {@link CollectionSpec} carries except `id`, `next_index_id` and
 * `next_rollup_id`. Those three are what {@link CollectionSpec} is worth
 * reading back *for*: the store assigns them, and for a collection that
 * already exists it ignores whatever a caller sent for them outright — see
 * {@link ClientToken.establish}. A caller declaring a collection has none of
 * the three to give, on a first declaration or a tenth.
 */
export interface CollectionDeclaration {
  name: string;
  key: PrimaryKey;
  /** Left out (`undefined`) declares no indexes at all — the same thing `null` means on {@link CollectionSpec}, read back. */
  indexes?: IndexDeclaration[] | null;
  partition?: Partition;
  rollups?: RollupDeclaration[];
}

/**
 * A collection as it was declared. Mirrors `store.Spec`.
 *
 * `next_index_id`/`next_rollup_id` are the one place this shell's wire
 * breaks its own naming habit of one short lower-case word per field: the
 * store's own struct tags spell them with an underscore, unlike every other
 * field here, and this keeps that spelling rather than "fixing" it into
 * `nextIndexId` and silently losing the value.
 */
export interface CollectionSpec {
  name: string;
  key: PrimaryKey;
  /** Never absent — `null` when the collection was declared with no indexes. */
  indexes: IndexSpec[] | null;
  partition?: Partition;
  rollups?: RollupSpec[];
  id: number;
  next_index_id: number;
  next_rollup_id: number;
}

/**
 * What a database holds: the collections and their indexes, and the
 * operations declared against them. Mirrors `store.Catalogue`.
 *
 * `collections` carries no `omitempty` on the Go side, and the loop that
 * fills it in only ever appends — starting from a `nil` slice, on a database
 * with no collections declared yet, it is never entered, and a `nil` slice
 * with no `omitempty` marshals as JSON `null`, not `[]`. Verified against the
 * real daemon in tests/server.test.mjs: `catalogue: true` before `sapedb
 * apply` has ever run answers `{"collections":null,"operations":[]}`. A
 * caller that assumes an array here and reaches straight for `.map` breaks
 * on exactly the database that most needs the catalogue read to work: the
 * one nobody has declared anything in yet.
 */
export interface Catalogue {
  collections: CollectionSpec[] | null;
  operations: Operation[];
}

/**
 * What `explore` hands back: the rows (empty envelope when this was a
 * `catalogue` ask instead), and the declaration the typed access would have
 * to be. Mirrors `server.explored`.
 *
 * `result` and `draft` carry no `omitempty` on the Go side and are always
 * present — including on a `catalogue` ask, where the store never assigns
 * either and they arrive as `{"operation":"","version":0}` and
 * `{"name":"","collection":"","action":""}` rather than being left out. They
 * are not meaningful there; `here` is what a `catalogue` ask actually
 * answers, and the field is called `here`, not `catalogue` — the request
 * flag and the response payload are two different names for the related but
 * not identical ideas of asking for the catalogue and being handed one.
 */
export interface Explored<Row = unknown> {
  result: InvokeResult<Row>;
  draft: Operation;
  /** Present only when the request asked `catalogue: true`. */
  here?: Catalogue;
}

/**
 * What `explore` asks for: a typed access, or the catalogue instead of
 * reading any of it. Mirrors `server.exploring`.
 *
 * Sending both is not refused — the store answers the catalogue and never so
 * much as looks at `access` — but only one is ever the caller's actual
 * intent, which is why {@link ClientToken.explore} takes them as one object
 * rather than two arguments that could disagree.
 */
export interface ExploreRequest {
  /** What to look at. Required unless `catalogue` is `true`. */
  access?: Access;
  /** Ask what the database holds instead of reading any of it. */
  catalogue?: boolean;
}

/** What answers an `elevate`: whether this connection is now an operator. */
export interface Elevated {
  operator: boolean;
}

/**
 * One operation as `sapedb-types` writes it down: what it takes, and what one of
 * its rows is.
 *
 * `row` is honest about how little a schema says. A schema declares
 * collections, indexes and operations — it never declares the shape of a
 * document, because this store deliberately does not impose one. So the only
 * read whose rows have a knowable shape is one with a `projection`, where the
 * declaration names the fields that come back. Everything else is a document
 * the schema has no opinion about, and its row type is
 * `Record<string, unknown>`.
 */
export interface OperationType {
  args: Record<string, unknown>;
  row: unknown;
}

/**
 * A generated schema: operation name → its type.
 *
 * Written against the schema's own keys rather than as
 * `Record<string, OperationType>`, because the generated file declares an
 * `interface` and an interface has no index signature — a record constraint
 * would refuse the very files this exists to accept, and the error it gives
 * ("index signature for type 'string' is missing") says nothing at all about
 * what is actually wrong.
 */
export type SchemaTypes<Schema> = { [Name in keyof Schema]: OperationType };

/**
 * The argument names that must be passed, which is what decides whether the
 * argument object may be left out altogether.
 */
type RequiredArgs<Args> = {
  [Key in keyof Args]-?: object extends Pick<Args, Key> ? never : Key;
}[keyof Args];

/* A rest tuple rather than two overloads: it is the only way to make the
   argument object required for one operation and optional for another while
   the operation is still being inferred from the name beside it. */
type InvokeArgs<Args> = [RequiredArgs<Args>] extends [never]
  ? [args?: Args, options?: InvokeOptions]
  : [args: Args, options?: InvokeOptions];

/**
 * A client whose calls are checked against a schema.
 *
 * Everything but `invoke` is the untyped client's: a subscription carries
 * changes from collections the caller never named, so nothing about a schema
 * narrows it.
 */
export interface TypedClientToken<Schema extends SchemaTypes<Schema>> extends Omit<ClientToken, "invoke"> {
  /**
   * Calls a declared operation. The name must be one the schema declares and
   * the arguments must be what it declares them to be — both decided here,
   * rather than by the store a network round trip later.
   */
  invoke<Name extends keyof Schema & string>(
    target: string | ConnectionTarget,
    command: Name,
    ...rest: InvokeArgs<Schema[Name]["args"]>
  ): Promise<InvokeResult<Schema[Name]["row"]>>;
}

export type TypedClientClass<Schema extends SchemaTypes<Schema>> = new () => TypedClientToken<Schema>;

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** A subscription that is running on a connection. */
interface Feed {
  onChange(change: unknown): void;
  onEnd(reason?: unknown): void;
}

interface Entry {
  key: string;
  target: ConnectionTarget;
  connection: Connection | null;
  opening: Promise<Connection> | null;
  pending: Map<number, Pending>;
  feeds?: Map<number, Feed>;
  nextId: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  keepAliveTimer: ReturnType<typeof setInterval> | null;
  /**
   * What the store said when it refused this connection during the
   * handshake — a Failure frame with id 0, which is the only id a rejected
   * handshake can carry, because nothing had assigned this connection a
   * real one yet. `open()` does not wait for a Welcome before handing the
   * connection back, so this is the only place that reason is ever seen
   * before the socket closes and takes it with it. Set in `handle`, read in
   * the `onClose` handler below, and never touched again after that: a
   * fresh `Entry` is what the next connection attempt gets, once this one
   * is torn down.
   */
  refusal?: Refused;
  /**
   * The welcome's `challenge`, once it arrives — what {@link ClientToken.elevate}
   * signs. `open()` hands the connection back without waiting for the
   * welcome, so a caller reaching for the challenge before it lands awaits
   * this instead of racing the socket. Rejects with whatever {@link refusal}
   * (or connection error) means it is never coming; resolved and rejected are
   * both set once, by `handle`/`teardown`, and never touched again — a fresh
   * `Entry` is what the next connection attempt gets.
   */
  challengeReady: Promise<string>;
  resolveChallenge: (value: string) => void;
  rejectChallenge: (reason: unknown) => void;
}

interface Breaker {
  failures: number;
  openUntil: number;
}

const DEFAULTS = {
  connectTimeout: 5_000,
  requestTimeout: 15_000,
  idleTimeout: 60_000,
  keepAlive: 20_000,
  failures: 3,
  cooldown: 5_000,
};

function unref(timer: unknown): void {
  (timer as { unref?: () => void })?.unref?.();
}

/**
 * Builds a client class. The pool lives with the class, so every `new` shares
 * it; two `Client()` calls are two pools.
 */
export function Client(options: ClientOptions): ClientClass;
/**
 * The same client, with its calls checked against a generated schema:
 *
 * ```ts
 * import type { Schema } from "./sapedb-schema";
 *
 * const store = new (Client<Schema>({ transport, mode: "bound" }))();
 * await store.invoke(url, "orders.pay", { order, amount, at, reference });
 * ```
 *
 * A schema argument changes nothing at runtime — the same class, the same
 * pool, the same frames. It only moves a wrong name or a missing argument from
 * a failure the store sends back to an error the compiler gives.
 */
export function Client<Schema extends SchemaTypes<Schema>>(options: ClientOptions): TypedClientClass<Schema>;
export function Client(options: ClientOptions): ClientClass {
  if (typeof options?.transport?.connect !== "function") {
    throw new TypeError("[ecosy/sapedb] Client needs a transport");
  }

  const mode = options.mode ?? "account";
  const connectTimeout = options.connectTimeout ?? DEFAULTS.connectTimeout;
  const requestTimeout = options.requestTimeout ?? DEFAULTS.requestTimeout;
  const idleTimeout = options.idleTimeout ?? DEFAULTS.idleTimeout;
  const keepAlive = options.keepAlive ?? DEFAULTS.keepAlive;
  const maxFailures = options.breaker?.failures ?? DEFAULTS.failures;
  const cooldown = options.breaker?.cooldown ?? DEFAULTS.cooldown;
  const logger = options.logger ?? console;

  const state = globalState("client", options.storageKey, () => ({
    entries: new Map<string, Entry>(),
    breakers: new Map<string, Breaker>(),
  }));

  const keyOf = (target: ConnectionTarget) =>
    mode === "bound"
      ? `${target.accountId}@${target.host}:${target.port}/${target.dbname}`
      : `${target.accountId}@${target.host}:${target.port}`;

  const settleAll = (entry: Entry, error: unknown) => {
    for (const pending of entry.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }

    /* A feed on a connection that has gone is a feed that has stopped. Leaving
       it silent would have somebody waiting for changes that will never come,
       on a database that is busily making them. */
    if (entry.feeds) {
      for (const feed of entry.feeds.values()) feed.onEnd(error);
      entry.feeds.clear();
    }
    entry.pending.clear();
  };

  const teardown = (entry: Entry, error?: unknown) => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.keepAliveTimer) clearInterval(entry.keepAliveTimer);
    entry.idleTimer = null;
    entry.keepAliveTimer = null;

    const connection = entry.connection;
    entry.connection = null;
    entry.opening = null;

    if (state.entries.get(entry.key) === entry) state.entries.delete(entry.key);

    const reason = error ?? new Unavailable("the connection closed");
    settleAll(entry, reason);
    /* A no-op once the welcome already answered — rejecting a settled promise
       changes nothing — but the one thing that stops an `elevate()` awaiting
       a challenge that will now never come from hanging past the connection
       it was waiting on. */
    entry.rejectChallenge(reason);
    try {
      connection?.close();
    } catch {
      // Closing a connection that is already gone is not an error worth having.
    }
  };

  const touch = (entry: Entry) => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (!idleTimeout) return;

    entry.idleTimer = setTimeout(() => {
      /* Only while nothing is waiting: an idle timer must never cut a call
         short. */
      if (entry.pending.size === 0) teardown(entry, new Unavailable("the connection was idle"));
    }, idleTimeout);
    unref(entry.idleTimer);
  };

  const handle = (entry: Entry, frame: Frame) => {
    if (frame.id === 0) {
      /* A Welcome is id 0 too. `open()` sends hello and hands the connection
         back without waiting for either frame, so the call this connection
         was opened for is already on its way; without reading a Failure here,
         the reason the store gave would be thrown away, and `onClose` below
         would have nothing left to settle that call with but "the store
         closed the connection". A Welcome carries the challenge an operator
         would have to answer — the one thing here worth remembering, for
         whichever `elevate()` call is waiting on it. */
      if (frame.type === FrameType.failure) {
        const body = decodeJsonPayload<{ message?: string; code?: string }>(frame);
        entry.refusal = new Refused(body?.message ?? "the store refused the connection", body?.code ?? "refused");
        entry.rejectChallenge(entry.refusal);
      } else if (frame.type === FrameType.welcome) {
        const body = decodeJsonPayload<{ challenge?: string }>(frame);
        if (body?.challenge) entry.resolveChallenge(body.challenge);
      }
      return; // Nobody asked for this, so nobody is waiting.
    }

    /* An event belongs to a subscription, which stays open long after the
       call that opened it was answered. Routed by the same id, because that
       is what lets one connection carry several feeds at once. */
    if (frame.type === FrameType.event) {
      const feed = entry.feeds?.get(frame.id);
      if (feed) {
        try {
          feed.onChange(decodeJsonPayload(frame));
        } catch (error) {
          logger.warn("[ecosy/sapedb] a subscription handler threw", error);
        }
      }
      return;
    }

    const pending = entry.pending.get(frame.id);
    if (!pending) {
      /* A failure on a subscription arrives long after its call was answered:
         the feed has ended and whoever is reading it has to be told. */
      if (frame.type === FrameType.failure) {
        const feed = entry.feeds?.get(frame.id);
        if (feed) {
          entry.feeds?.delete(frame.id);
          const body = decodeJsonPayload<{ message?: string; code?: string }>(frame);
          feed.onEnd(new Refused(body?.message ?? "the feed ended", body?.code ?? "refused"));
        }
      }
      return;
    }

    entry.pending.delete(frame.id);
    if (pending.timer) clearTimeout(pending.timer);
    touch(entry);

    if (frame.type === FrameType.failure) {
      const body = decodeJsonPayload<{ message?: string; code?: string }>(frame);
      pending.reject(new Refused(body?.message ?? "the store refused the call", body?.code ?? "refused"));
      return;
    }

    pending.resolve(frame.type === FrameType.pong ? null : decodeJsonPayload(frame));
  };

  const breakerFor = (target: ConnectionTarget) => {
    const key = `${target.accountId}@${target.host}:${target.port}`;
    return { key, breaker: state.breakers.get(key) ?? { failures: 0, openUntil: 0 } };
  };

  const open = async (entry: Entry): Promise<Connection> => {
    if (entry.connection) return entry.connection;
    if (entry.opening) return entry.opening;

    const { key: breakerKey, breaker } = breakerFor(entry.target);
    if (breaker.openUntil > Date.now()) {
      /* Fail fast rather than pay a connect timeout per call: a store that is
         down should cost the app a millisecond, not five seconds a request. */
      throw new Unavailable(`${redact(entry.target)} is not answering; not trying again for now`);
    }

    entry.opening = (async () => {
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Unavailable(`connecting to ${redact(entry.target)} timed out`)), connectTimeout);
        unref(timer);
      });

      const connection = await Promise.race([options.transport.connect(entry.target), timeout]);

      connection.onFrame((frame) => handle(entry, frame));
      connection.onClose((reason) => {
        if (state.entries.get(entry.key) === entry) {
          /* A refusal is the store answering "no" and saying why; a socket
             closing with no refusal on record is the store just going away.
             Those are different failures — one a caller should not retry,
             the other one it might — so they must not collapse into the
             same vague message just because both end the same way, in a
             closed connection. The close reason is not lost either way: it
             rides along as `cause` even when the error thrown is Refused. */
          const error = entry.refusal ?? new Unavailable("the store closed the connection", { cause: reason });
          if (entry.refusal) error.cause = reason;
          teardown(entry, error);
        }
      });

      connection.send(
        encodeJsonFrame(FrameType.hello, 0, {
          account: entry.target.accountId,
          password: entry.target.password,
          sig: entry.target.sig,
          ...(mode === "bound" ? { dbname: entry.target.dbname } : {}),
          mode,
        }),
      );

      entry.connection = connection;

      if (keepAlive > 0) {
        entry.keepAliveTimer = setInterval(() => {
          if (entry.pending.size === 0 && entry.connection) {
            try {
              entry.connection.send(encodeJsonFrame(FrameType.ping, nextId(entry), null));
            } catch {
              teardown(entry, new Unavailable("the connection broke while idle"));
            }
          }
        }, keepAlive);
        unref(entry.keepAliveTimer);
      }

      touch(entry);
      return connection;
    })();

    try {
      const connection = await entry.opening;
      state.breakers.delete(breakerKey);
      return connection;
    } catch (error) {
      entry.opening = null;
      const failures = breaker.failures + 1;
      state.breakers.set(breakerKey, {
        failures,
        openUntil: failures >= maxFailures ? Date.now() + cooldown : 0,
      });

      if (failures === maxFailures) {
        logger.warn(`[ecosy/sapedb] ${redact(entry.target)} failed ${failures} times; calls fail fast for ${cooldown}ms`);
      }

      teardown(entry, error);
      throw error instanceof SapedbError ? error : new Unavailable(`cannot reach ${redact(entry.target)}`, { cause: error });
    }
  };

  const entryFor = (target: ConnectionTarget): Entry => {
    const key = keyOf(target);
    const existing = state.entries.get(key);
    if (existing) return existing;

    let resolveChallenge!: (value: string) => void;
    let rejectChallenge!: (reason: unknown) => void;
    const challengeReady = new Promise<string>((resolve, reject) => {
      resolveChallenge = resolve;
      rejectChallenge = reject;
    });
    /* A safety net, not the real handler: `elevate()` attaches its own
       `await`/`.then` when it actually wants the challenge. Without this, a
       connection whose handshake is refused and whose caller never calls
       `elevate()` at all would leave this promise rejected with nobody ever
       having looked at it — an unhandled rejection Node warns about, or
       crashes on, for a challenge nobody asked for. */
    challengeReady.catch(() => {});

    const entry: Entry = {
      key,
      target,
      connection: null,
      opening: null,
      pending: new Map(),
      nextId: 0,
      idleTimer: null,
      keepAliveTimer: null,
      challengeReady,
      resolveChallenge,
      rejectChallenge,
    };
    state.entries.set(key, entry);
    return entry;
  };

  /** Ids wrap rather than grow: only the calls in flight have to be told apart. */
  function nextId(entry: Entry): number {
    do {
      entry.nextId = (entry.nextId % 0xffff_fffe) + 1;
    } while (entry.pending.has(entry.nextId));
    return entry.nextId;
  }

  /* Split out so that a subscription can take its id before the frame goes
     out: the store starts sending the moment it has answered, and an event
     that arrives before its handler is in place is a change nobody sees. */
  const sendOn = (
    entry: Entry,
    connection: Connection,
    id: number,
    type: number,
    body: Record<string, unknown>,
    timeout: number,
    target: ConnectionTarget,
  ) =>
    new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { resolve, reject, timer: null };

      if (timeout > 0) {
        pending.timer = setTimeout(() => {
          entry.pending.delete(id);
          reject(new Unavailable(`${redact(target)} did not answer within ${timeout}ms`));
        }, timeout);
        unref(pending.timer);
      }

      entry.pending.set(id, pending);

      try {
        connection.send(encodeJsonFrame(type, id, body));
      } catch (error) {
        entry.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        teardown(entry, error);
        reject(new Unavailable("the connection broke while sending", { cause: error }));
      }
    });

  const send = async (target: ConnectionTarget, type: number, body: Record<string, unknown>, timeout: number) => {
    const entry = entryFor(target);
    const connection = await open(entry);
    return sendOn(entry, connection, nextId(entry), type, body, timeout, target);
  };

  const resolveTarget = (target: string | ConnectionTarget) =>
    typeof target === "string" ? parseConnectionString(target) : target;

  return class ClientImpl implements ClientToken {
    async invoke<Result = unknown>(
      target: string | ConnectionTarget,
      command: string,
      args: Record<string, unknown> = {},
      invokeOptions: InvokeOptions = {},
    ): Promise<Result> {
      if (typeof command !== "string" || command.length === 0) {
        throw new TypeError("[ecosy/sapedb] invoke needs a command name");
      }

      const parsed = resolveTarget(target);
      const writeId = invokeOptions.write || invokeOptions.writeId ? (invokeOptions.writeId ?? ulid()) : undefined;

      const body: Record<string, unknown> = { command, args };
      if (mode === "account") {
        body.dbname = parsed.dbname;
        body.sig = parsed.sig;
      }
      if (writeId) body.writeId = writeId;
      if (invokeOptions.version) body.version = invokeOptions.version;
      // Omitted entirely when nothing was presented, so a call that never
      // sets this sends exactly the bytes it sent before grants existed —
      // fail-closed, matching the Go client's wire.go. `exp` and `serial` are
      // sent whenever `grant` is, never left off: the server's one message
      // shape has no branch for a grant missing either, and a client that
      // omitted them would silently send `exp:0`/`serial:""` and be refused
      // under `grant` rather than the field it actually forgot.
      if (invokeOptions.grant) {
        body.grant = {
          scopes: invokeOptions.grant.scopes,
          exp: invokeOptions.grant.exp,
          serial: invokeOptions.grant.serial,
          sig: invokeOptions.grant.sig,
        };
      }

      try {
        return (await send(parsed, FrameType.invoke, body, invokeOptions.timeout ?? requestTimeout)) as Result;
      } catch (error) {
        /* One reconnect, and only for work that can be repeated safely: a read,
           or a write carrying the id that makes a repeat harmless. */
        if (error instanceof Unavailable && (!invokeOptions.write || writeId)) {
          return (await send(parsed, FrameType.invoke, body, invokeOptions.timeout ?? requestTimeout)) as Result;
        }
        throw error;
      }
    }

    async subscribe(
      target: string | ConnectionTarget,
      options: SubscribeOptions,
      onChange: (change: Change) => void,
    ): Promise<Subscription> {
      if (typeof onChange !== "function") {
        throw new TypeError("[ecosy/sapedb] subscribe needs somewhere to put the changes");
      }

      const parsed = resolveTarget(target);
      const entry = entryFor(parsed);
      const connection = await open(entry);

      const body: Record<string, unknown> = { from: options.from };
      if (mode === "account") {
        body.dbname = parsed.dbname;
        body.sig = parsed.sig;
      }

      /* Registered before the request goes out. The store starts sending the
         moment it has answered, and an event that arrives before the handler
         is in place is a change nobody sees. */
      const id = nextId(entry);
      entry.feeds ??= new Map();
      entry.feeds.set(id, {
        onChange: onChange as (change: unknown) => void,
        onEnd: (reason) => options.onEnd?.(reason),
      });

      try {
        const confirmed = (await sendOn(entry, connection, id, FrameType.subscribe, body, requestTimeout, parsed)) as {
          from: number;
          latest: number;
          oldest: number;
        };

        return {
          ...confirmed,
          close: () => {
            entry.feeds?.delete(id);
          },
        };
      } catch (error) {
        entry.feeds?.delete(id);
        throw error;
      }
    }

    async ping(target: string | ConnectionTarget): Promise<number> {
      const startedAt = performance.now();
      await send(resolveTarget(target), FrameType.ping, {}, requestTimeout);
      return performance.now() - startedAt;
    }

    async elevate(
      target: string | ConnectionTarget,
      secret: string,
      elevateOptions: { timeout?: number } = {},
    ): Promise<Elevated> {
      if (typeof secret !== "string" || secret.length === 0) {
        throw new TypeError("[ecosy/sapedb] elevate needs the server's own secret");
      }

      const parsed = resolveTarget(target);
      const entry = entryFor(parsed);
      const timeout = elevateOptions.timeout ?? requestTimeout;
      const connection = await open(entry);

      const challenge = await Promise.race([
        entry.challengeReady,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Unavailable(`${redact(parsed)} did not send a challenge within ${timeout}ms`)),
            timeout,
          );
          unref(timer);
        }),
      ]);
      const proof = await operate(secret, challenge);

      return (await sendOn(entry, connection, nextId(entry), FrameType.elevate, { proof }, timeout, parsed)) as Elevated;
    }

    async explore<Row = unknown>(
      target: string | ConnectionTarget,
      request: ExploreRequest,
      exploreOptions: { timeout?: number } = {},
    ): Promise<Explored<Row>> {
      if (!request || (request.access === undefined && !request.catalogue)) {
        throw new TypeError("[ecosy/sapedb] explore needs an access to type, or catalogue: true");
      }

      const parsed = resolveTarget(target);
      const timeout = exploreOptions.timeout ?? requestTimeout;

      const body: Record<string, unknown> = {};
      if (request.access !== undefined) body.access = request.access;
      if (request.catalogue) body.catalogue = true;
      if (mode === "account") {
        body.dbname = parsed.dbname;
        body.sig = parsed.sig;
      }

      try {
        return (await send(parsed, FrameType.explore, body, timeout)) as Explored<Row>;
      } catch (error) {
        // Reading is always safe to retry once, the same as invoke() does for a read.
        if (error instanceof Unavailable) {
          return (await send(parsed, FrameType.explore, body, timeout)) as Explored<Row>;
        }
        throw error;
      }
    }

    async declare(
      target: string | ConnectionTarget,
      operation: Operation,
      declareOptions: { timeout?: number } = {},
    ): Promise<Operation> {
      if (!operation || typeof operation.name !== "string" || operation.name.length === 0) {
        throw new TypeError("[ecosy/sapedb] declare needs an operation with a name");
      }

      const parsed = resolveTarget(target);
      const timeout = declareOptions.timeout ?? requestTimeout;

      const body: Record<string, unknown> = { operation };
      if (mode === "account") {
        body.dbname = parsed.dbname;
        body.sig = parsed.sig;
      }

      /* Not retried on a dropped connection: unlike explore, this writes, and
         a redeclaration is never a no-op — a retry that landed after all
         would be a second version nobody asked for. */
      const answer = (await send(parsed, FrameType.declare, body, timeout)) as { operation: Operation };
      return answer.operation;
    }

    async establish(
      target: string | ConnectionTarget,
      spec: CollectionDeclaration,
      establishOptions: { timeout?: number } = {},
    ): Promise<CollectionSpec> {
      if (!spec || typeof spec.name !== "string" || spec.name.length === 0) {
        throw new TypeError("[ecosy/sapedb] establish needs a spec with a name");
      }

      const parsed = resolveTarget(target);
      const timeout = establishOptions.timeout ?? requestTimeout;

      const body: Record<string, unknown> = { spec };
      if (mode === "account") {
        body.dbname = parsed.dbname;
        body.sig = parsed.sig;
      }

      /* Not retried on a dropped connection, the same as declare(): this
         writes, and a repeat is not free even though it is safe — establishing
         the same collection twice is the same in-place upgrade both times, but
         one that adds an index or a rollup walks every document already
         stored to build it. A retry that landed after all would walk them
         again for work this caller never asked to pay for twice. */
      const answer = (await send(parsed, FrameType.establish, body, timeout)) as { spec: CollectionSpec };
      return answer.spec;
    }

    async close(): Promise<void> {
      for (const entry of [...state.entries.values()]) {
        teardown(entry, new Unavailable("the client was closed"));
      }
      state.breakers.clear();
    }

    stats(): PoolStats {
      let inFlight = 0;
      for (const entry of state.entries.values()) inFlight += entry.pending.size;

      return {
        connections: state.entries.size,
        inFlight,
        tripped: [...state.breakers.entries()].filter(([, breaker]) => breaker.openUntil > Date.now()).map(([key]) => key),
      };
    }
  };
}
