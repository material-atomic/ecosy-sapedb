# Changelog

## Unreleased

### Breaking

- The package is now `@ecosy/sapedb`. Import paths and the bin name moved
  with it, the connection string's scheme changed to match, and the
  environment-variable prefix used in this package's own examples and tests
  moved too — a naming suggestion only, since nothing in `src/signer` reads
  the process environment itself. Four `Symbol.for` keys moved as well:
  three brand keys used to recognise `CommandNotFound`, `CommandUnauthorized`,
  and `CommandCycle` across this package's two builds, plus one key built
  from a template for internal global state (`<namespace>:<storageKey>`),
  all now namespaced under the new name.

  To upgrade: rename the dependency in `package.json` and update every
  import path that named the old package. Any code that matches a
  `Symbol.for` key by a hand-written string literal — the four above, or
  any other reached the same way — needs the new key.

- `tryRun` no longer swallows every error a runner can produce. Before this
  change, a bare `catch { return fallback }` turned a runner throwing, auth
  refusing, or a cycle into the same `fallback` as a missing command — a
  declared command whose runner blew up read exactly like a command nobody
  had ever declared. Now only a lookup miss on the registry
  (`CommandNotFound`) answers `fallback`; a runner throwing, auth refusing,
  or a cycle all rethrow instead.

  To upgrade: every `tryRun` call site can now throw where it previously
  could not. A `tryRun` whose result was used without a surrounding `try`
  needs one, or needs the failure to reach the caller on purpose.
- `tryRun` now answers `fallback` only when the command **asked for** is not
  declared. Previously, a `CommandNotFound` raised anywhere inside a
  declared command's own runner — one command calling another that does not
  exist — was also swallowed into `fallback`, even though the command that
  was asked for existed. That case now rethrows, with the error naming the
  command that actually missed, not the one the caller asked about.

  To upgrade: code that relied on the old behaviour has to catch the miss
  where the nested call is made, inside the runner, rather than at the
  `tryRun` that started the call:

  ```js
  const runner = async ({ run }) => {
    try {
      return await run("maybe-not-declared");
    } catch (error) {
      if (CommandNotFound.is(error)) return somethingElse;
      throw error;
    }
  };
  ```

  Calling `bus.tryRun(...)` from inside a runner looks like the shorter way
  to do this and is not equivalent. The `run` handed to a runner continues
  the call already in progress; the bus's own `tryRun` starts a new one. A
  runner that reaches back for the bus therefore gets a fresh cycle check
  that cannot see the commands already running — `a` calling `bus.tryRun("a")`
  recurses until the stack overflows instead of raising `CommandCycle` — and
  its trace lines are written to that new call and discarded, so the nested
  miss is missing from the `traceLog()` the outer caller reads.

### Fixed

- A connection the store refuses during the handshake — mode `bound`, a
  signature that does not verify — now rejects with `Refused`, carrying the
  store's own message and code. Before this, the store's answer arrived on
  the wire (a Failure frame at id 0) and was discarded, because id 0 is also
  what a Welcome carries and nothing was waiting on it; every caller instead
  saw the socket close and got `Unavailable("the store closed the
  connection")`, with no code at all — a store answering "no" and a store
  going away for no stated reason looked identical.

  To upgrade: code that catches this case by checking `instanceof
  Unavailable` (or matching its message) needs to catch `instanceof Refused`
  instead, and can read `error.code` for what the store actually said.

### Added

- `sapedb-types --from <connection-string>` and `schemaFromServer` (ISS-20):
  the generator can now read a running store's catalogue instead of a
  `schema.json` on disk. Before this, the shape of a module installed over the
  wire — `establish` for its collections, `declare` for its operations, never
  written to anyone's disk — had to be copied by hand into whoever called it:
  the store had been answering `WhatIsHere` with every declaration it holds,
  and nothing joined that to the generator.

  `schemaFromServer(client, target, secret)` proves the secret, asks for the
  catalogue and hands back the same `Schema` a file parses to, so both sources
  reach the same `typesFor`. It takes the two methods it calls rather than a
  `Client`, which keeps `@ecosy/sapedb/types` free of the driver and the
  transport. The secret is not optional: the store refuses an unelevated
  `explore` with `not_operator`, and the CLI refuses without `--secret` (or
  `SAPEDB_SECRET`) before it dials at all. The file path is unchanged, down to
  the byte — `tests/types.test.mjs` runs the bin against the fixture and
  compares it with the committed `tests/typecheck/ledger.d.ts`.

  One difference between the two sources is real and is not flattened away:
  **the order**. A file lists its operations as somebody wrote them; the store
  keys them by name, so a catalogue arrives name-ordered with no memory of the
  file's order. The same schema therefore declares the same operations in
  different places — every other byte identical, measured line for line
  against a real daemon in `tests/types-from-server.test.mjs`. Neither side is
  sorted to match: an interface's member order means nothing to the compiler,
  and reordering the file path would change the one output that already has
  users. The generated header names its source either way, with a connection
  string's password and signature redacted.

- `InvokeOptions.grant` (ISS-12): `invoke` can now present a scope grant, so an
  operation declared with `scopes` (added to the wire in 1.0.0) is one this
  client can actually call. Before this, `grep -riF grant src/` found
  nothing — the Go client could present a grant (`Client.Present`,
  `sapedb.go`) and this one could not, so a scoped operation was reachable
  from two of three clients.

  `invoke(target, command, args, { grant: { scopes, sig } })` sends
  `{"grant":{"scopes":[...],"sig":"..."}}` on the wire, omitted entirely when
  no grant is given — matching what every call sent before grants existed, and
  matching the Go client's own `wire.go`. `sig` is an HMAC the server's secret
  makes over the account, the database and the exact scope list
  (`internal/signing/signing.go`'s `GrantLabel`/`Granting`/`Grants`); nothing
  here can mint one, on purpose — that needs the secret this client is never
  given, and minting stays the server's `Server.Grant`. A grant that does not
  verify is refused with code `grant`; an operation whose scopes were never
  presented at all is refused with `not_allowed`, naming the scope it needed —
  two different codes for two different problems, both proven end to end
  against a real daemon in `tests/server.test.mjs`.

- `elevate` and `explore`: the operator shell, frame types 11 and 12. Two
  measurements (an R&D pass over the desktop app and a planner pass over the
  end-to-end path) found the same thing independently: `FrameType` stopped at
  `goodbye: 10`, so the whole administrative channel — the one an admin
  screen and a desktop app both need to read a database without a declared
  operation for every question — could only be reached from Go. This closes
  that gap on the reading side only; nothing here writes.

  - `Client#elevate(target, secret, options?)` proves this connection holds
    the server's own secret, over the challenge its welcome carried, and
    returns `{ operator: boolean }`. The proof is `@ecosy/sapedb/signer`'s
    new `operate(secret, challenge)`, the client side of the store's
    `signing.Operating` — same derived key, under `OPERATOR_LABEL`, over the
    raw challenge bytes. It does not survive a reconnect: a connection the
    pool re-opens gets a fresh challenge and starts unelevated, same as a
    brand new one.
  - `Client#explore(target, request, options?)` runs a typed `get`, `scan` or
    `count` an operator names directly, or asks what the database holds
    (`{ catalogue: true }`), on a connection that has called `elevate`; both
    are refused with code `not_operator` otherwise. Every wire type this
    touches — `Access`, `Bound`, `Term`, `Endpoint`, `Operation`,
    `CollectionSpec`, `Catalogue`, `Explored` — is exported from
    `@ecosy/sapedb/client`, checked field for field against the store's own
    `json` tags rather than against this package's usual naming habits. Three
    places where that check actually mattered, each confirmed against a real
    daemon in `tests/server.test.mjs` rather than assumed:

    - `store.Bound` (an access's `from`/`to`) carries no `json` tag at all,
      so the store would marshal one as `{"Values":...,"Exclusive":...}` —
      capitalized — if it ever sent one back. It never does; a `Bound` is
      only ever read. Sending it lower-case, `{ values, exclusive }`, matching
      everything else `explore` carries, still lands correctly, because
      `encoding/json`'s decoder falls back to a case-insensitive match
      against the exported field name when nothing more specific claims it.
    - `store.Catalogue.Collections` carries no `omitempty`, and is only ever
      appended to — never initialized to `[]` — so a database with nothing
      declared yet answers `"collections":null`, not `"collections":[]`. The
      TypeScript type is `CollectionSpec[] | null` for exactly that reason.
    - A `store.Result` embedded in what `explore` answers always carries
      `"operation":""` and `"version":0` rather than omitting them — `Explore`
      blanks both on purpose, because a drafted access is not a declared
      operation and has neither a name nor a version to report.

  - `fixtures/frames.json` gained `elevate`/`explore` in its `types` map and
    four cases exercising the new frame bodies. Deliberately setting
    `types.explore` to a code the fixture did not agree with the store on
    (verified against an isolated copy of the store's own repo, restoring it
    after and never touching the checked-in one) turned
    `TestFixtureFramesDecodeAsTheClientWroteThem` red on the Go side, with
    the mismatch named in the failure. No test on this side reads the fixture
    at all today — `tests/protocol.test.mjs` checks `FrameType` against its
    own hand-written cases, not against `fixtures/frames.json` — which is a
    pre-existing gap this change did not close.

- `Client#declare(target, operation, options?)`, frame type 13, and
  `InvokeOptions.version`. The Go client already had both (`Client.Declare`,
  `Client.InvokeVersion`, commits `72f6b2c` and `2a05cab` on the store's
  side); this closes the gap on the TypeScript side.

  - `declare` stores an operation on a database whose server is already
    running, on a connection that has called `elevate` — the store's own
    `store.DeclareOperation`, the function `sapedb apply` calls, reached over
    a socket instead of the exclusive file lock `apply` needs, which is what
    used to force stopping the server to add one operation. Not operating
    the connection is refused with `not_operator`, same as `explore`.
    Declaring a name that is already declared writes a **new version** and
    leaves the old one exactly as it was; there is no "nothing changed, so
    nothing happened" — the same declaration sent twice is two versions, not
    one. It also runs the same validation `apply` does, with no second copy
    of the rules and nothing normalised on the way in: a `scan` declared with
    no `limit` is refused in the store's own words
    (`sapedb/store: the declaration does not make sense: a scan must declare
    how many rows it may return`), even though the identical shape sent
    through `explore` is accepted, because `explore` silently fills the limit
    in before it checks anything and a declaration is a promise about cost
    nothing here may make on a caller's behalf.
  - `InvokeOptions.version` runs one particular declared version instead of
    whatever the name currently resolves to — the only way to reach a
    declaration after something has been declared over the top of it. Left
    out, or `0`, this is the call every caller already knows; the field is
    never sent on the wire at `0`, matching the store's own `omitempty`. This
    is an addition to `InvokeOptions`, not a new parameter on `invoke` — the
    Go client took a second method (`InvokeVersion`) for the same reason:
    `invoke`'s signature already shipped and this package does not take that
    back for a field almost no caller passes.
  - Both measured against a real daemon in `tests/server.test.mjs`: a
    declaration lands in the catalogue and is callable while the daemon
    keeps the same pid throughout; a `declare` before `elevate` is refused,
    checked against a connection that had already declared successfully
    moments before so the refusal cannot be mistaken for a driver that was
    never wired up; the scan-with-no-limit refusal is checked against the
    store's exact wording, with the same shape through `explore` checked
    accepted right beside it; and a redeclare followed by an explicit
    `version: 1` still reaches the older, differently-projected rows after
    the unversioned call has moved on to the new one.

- `Client#establish(target, spec, options?)`, frame type 14 (SAPE-14). The
  server can now declare a *collection* on a database whose server is
  already running, the other half of the gap `declare` closed for
  operations, and this is the driver method for it — `store.Declare`, the
  function `sapedb apply` calls, reached over the socket `elevate` proved
  instead of the exclusive file lock `apply` needs.

  `declare` and `establish` answer "the name is already declared"
  differently, and the difference is not this driver's choice — it is
  `store.Declare`'s own behaviour, read off a real daemon rather than
  assumed. An operation is versioned: a caller is built against one, so a
  redeclaration writes a **new version** and leaves the old one runnable. A
  collection has no version to give — it is where the documents physically
  are, and there is one of those — so establishing a name that already
  exists brings **that** collection up to date **in place**: indexes and
  rollups it names are built over the documents already stored, or kept as
  they were; ones it leaves out are dropped, entries and all; and what
  cannot be changed in place (the primary key, how the collection is
  divided, an index that keeps its name and changes its shape) is refused,
  in the store's own words, rather than done quietly or as a second
  collection nobody asked for.

  `CollectionDeclaration` (and `IndexDeclaration`/`RollupDeclaration`) is
  what `establish` takes — `CollectionSpec` minus the fields the store
  assigns (`id`, `next_index_id`, `next_rollup_id`, and each index's and
  rollup's own `id`): a caller declaring a collection has none of those to
  give, on a first declaration or a tenth, and `CollectionSpec` itself is
  unchanged so nothing that already reads a catalogue is affected. Not
  operating the connection is refused with `not_operator`, same as
  `explore`/`declare`. Four things measured against a real daemon in
  `tests/server.test.mjs`, each against its own positive control: a
  collection established over the wire, an operation declared and invoked
  against it, with the daemon's pid unchanged throughout; `establish` before
  `elevate` refused with nothing written; the exact same declaration sent
  twice comes back with the same id, so it reads as one collection and not
  two; and moving an existing collection's primary key is refused verbatim
  in the store's own words, not a paraphrase this driver made up.

- `CommandNotFound.is()`, `CommandUnauthorized.is()`, `CommandCycle.is()`.
  This package ships two builds of `src/commander/index.ts` — `import`
  resolves to `dist/commander/index.mjs`, `require` to
  `dist/commander/index.js` — and `package.json`'s `exports` map wires both
  to the same subpath. A process that reaches this module through both
  loads two distinct classes named `CommandNotFound` (and `CommandUnauthorized`,
  `CommandCycle`), so `instanceof` between an instance from one build and the
  class from the other is always `false`, even for an error one of those
  classes threw a moment earlier in the other build. `is()` recognises an
  instance of either build; code that catches these errors — including a
  consumer's own `catch` — should use `is()`, not `instanceof`.

- `Step` gains `operation`, `version` and `with`: a step of a batch may now
  name an already-declared operation instead of touching a collection, the
  same composed operations the store gained on the Go side (`d730d10`,
  `2d9723c`). This closes the gap the store's own changelog called out by
  name: "`@ecosy/sapedb` cannot build or read a composed declaration until
  its own `Step` is widened."

  `Step.action` and `Step.collection` are now optional rather than required,
  because a step that calls an operation sets neither — code that read
  `step.action`/`step.collection` unconditionally, assuming every step
  touches a collection, now gets a type error and needs to check
  `step.operation` first, the same discriminant the store itself uses.

  Three things measured against the real store rather than assumed, because
  each is a constraint the wire enforces and not a suggestion:

  - `version` must be greater than zero — there is no "run whichever version
    is newest". A composed operation's declared cost would otherwise change
    the moment somebody redeclared the callee, silently.
  - The readable ceiling of a composed operation, **at any depth**, is its
    own declared `limit` — never a product of what its steps call. The store
    refuses a declaration whose steps' ceilings sum to more than that limit,
    in its own words: `sapedb/store: the declaration does not make sense:
    the steps of "..." may return N rows between them, and it declares a
    limit of M`.
  - A step runs exactly once: a `with` term may take a value from an earlier
    step's key only when that step's own ceiling is 1. Naming a step whose
    ceiling is greater than 1 is refused, not truncated to its last row.

  What this does *not* do: `InvokeResult.rows` stays flat, in step order,
  with no label saying which step a row came from, for a composed operation
  exactly as it already did for a plain batch. And it is not sold as
  faster — the store's own measurement found composing saves no fsync a
  batch was not already saving, and the round trip it saves came to
  0.099–0.131 ms on loopback, the size of the noise between two runs of the
  same measurement. What it buys is atomicity and a count of round trips
  saved, not a duration.

  All three measured end to end against a real daemon in
  `tests/server.test.mjs`: a composed operation declared over the wire,
  invoked once, answering rows from both legs it names; the same shape one
  row over its declared ceiling, refused in the store's exact words; and a
  step reaching for another step's key across a leg that may answer more
  than one row, refused before either step ever runs.
