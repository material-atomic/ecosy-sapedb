# @ecosy/rsql

RSQL: a storage service addressed by a connection string.

```
rsql://<user_id>:<password>@<host>:<port>/<project_id>?sig=<hex>
```

Two sides — a TypeScript app and a store — agreeing on one signature and one
wire format. The engine behind the address is an implementation detail; drivers
are separate, the way `@ecosy/orm` keeps them.

## Subpaths

| Import | What it is |
| --- | --- |
| `@ecosy/rsql/signer` | The signing contract, and the fixture both languages test against |
| `@ecosy/rsql/commander` | Named execution: commands declared as data, run by name |
| `@ecosy/rsql/shape` | Discovery: what a project publishes, by `kind` |

## The signing contract

```
key = HMAC-SHA256(RSQL_SECRET, label)
sig = hex(HMAC-SHA256(key, user_id ":" password ":" project_id))
```

Lower-case hex, no Unicode normalisation on either side, compared in constant
time. `password` is `[A-Za-z0-9._~-]{16,128}`: one encoding per password, and
no `:` to make the concatenation ambiguous.

`fixtures/signing.json` carries triples with their expected digests. Both the Go
store's tests and this package's tests read it, so a change to the contract
turns both suites red at once instead of surfacing as a user who cannot connect.
