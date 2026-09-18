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
| `@ecosy/rsql/types` | Turns a `schema.json` into a `.d.ts`, so a wrong call does not compile |

## Calls checked before they are made

A schema already says which operations exist, what each one takes, and which of
those arguments are required. `rsql-types` writes that down as TypeScript:

```sh
npx rsql-types schema.json > src/rsql-schema.d.ts
```

```ts
import { Client } from "@ecosy/rsql/client";
import type { Schema } from "./rsql-schema";

const store = new (Client<Schema>({ transport, mode: "bound" }))();

await store.invoke(url, "orders.pay", { order: "ord-1", amount: 249.5, at, reference: "x" });
await store.invoke(url, "orders.pya", { order: "ord-1", amount: 249.5, at, reference: "x" });
//                      ^ Argument of type '"orders.pya"' is not assignable to parameter of
//                        type '"orders.place" | "orders.pay" | "orders.get" | ...'
```

A wrong name, a missing required argument, an argument of the wrong type and an
argument the operation does not take are each a compile error rather than a
refusal from the store a round trip later. `Client(…)` without a schema is
unchanged and still takes any name and any arguments.

**What the types cannot tell you.** A schema declares collections, indexes and
operations. It does not declare the shape of a document — this store
deliberately does not impose one — so there is nothing to derive a row type
from. The one exception is a read with a `projection`, which names the fields
that come back: there the field *names* are known and their types still are
not, and each is optional because the store keeps only the fields the document
actually had. Every other read is `Record<string, unknown>`. That is the
schema's true answer, not a gap waiting to be filled in.

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
