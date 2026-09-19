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
