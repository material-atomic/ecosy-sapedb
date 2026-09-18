# Changelog

## Unreleased

### Breaking

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

### Added

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
