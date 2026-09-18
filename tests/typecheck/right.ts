/**
 * The calls a schema allows. `tsc` must report nothing at all in this file.
 *
 * It is the control for `wrong.ts`: without it, a typed `invoke` that refused
 * everything would pass that suite perfectly. The two files make the same
 * calls, one of them correctly.
 */

import { Client, type InvokeResult, type Transport } from "@ecosy/rsql/client";

import type { Books } from "./books";
import type { Coverage, CoverageOperation } from "./coverage";
import type { Schema } from "./ledger";

declare const transport: Transport;
declare const url: string;

const ledger = new (Client<Schema>({ transport, mode: "bound" }))();
const library = new (Client<Books>({ transport, storageKey: "books" }))();
const items = new (Client<Coverage>({ transport, mode: "bound" }))();

export async function aWrite(): Promise<number | undefined> {
  const paid = await ledger.invoke(
    url,
    "orders.pay",
    { order: "ord-1", amount: 249.5, at: Date.now(), reference: "bank-ref" },
    { write: true },
  );
  return paid.changed;
}

export async function aDocument(): Promise<Record<string, unknown> | undefined> {
  const order = await ledger.invoke(url, "orders.get", { id: "ord-1" });
  /* `orders.get` declares no projection, so the schema says nothing about what
     comes back beyond it being a document. This is as far as the type goes,
     and it is the honest end of it. */
  return order.rows?.[0];
}

export async function aProjection(): Promise<unknown> {
  /* `since` has a default, so it may be left out. The projected keys are the
     declared paths verbatim, "author.name" included. */
  const shelf = await library.invoke(url, "books.on_shelf", { shelf: "history" });
  return shelf.rows?.[0]?.["author.name"];
}

export async function noArguments(): Promise<number | undefined> {
  // An operation that declares no input takes no argument object either.
  const counted = await library.invoke(url, "books.how_many");
  return counted.count;
}

export async function everythingElse(): Promise<number> {
  /* A schema narrows what may be invoked and nothing else. A feed carries
     changes from every collection, named by this caller or not, so nothing
     about a schema narrows it — and the rest of the client has to stay
     reachable from a typed one. */
  const feed = await ledger.subscribe(url, { from: 1 }, (change) => void change.lsn);
  feed.close();
  ledger.stats();
  return ledger.ping(url);
}

/* Below: the coverage schema, which exists so that every argument type and
   every action the generator claims to handle is actually called somewhere.
   The two schemas above are real ones and between them they declare `string`,
   `number` and five of the nine actions; the rest was being generated and
   never compiled against. */

export async function everyArgumentTypeTheStoreDeclares(): Promise<unknown> {
  /* `string`, `number`, `bool` and `any` in one call. `flag` is the only bool
     anything here declares, so a generator that wrote it down as a string
     would refuse `true`. `extra` is declared `any`, which the store means as
     "not checked", so any value at all belongs there. */
  const added = await items.invoke(
    url,
    "items.add",
    { id: "it-1", kind: "book", at: Date.now(), amount: 9.5, flag: true, extra: { whatever: [1, "two"] }, label: "gift" },
    { write: true },
  );
  return added.key;
}

export async function whatMayBeLeftOut(): Promise<unknown> {
  /* Three ways a schema says an argument is optional, all left out here:
     `flag` says `"required": false` in so many words, `extra` says nothing
     about required at all, and `label` carries a default the store fills in.
     Only the four that say `"required": true` are passed. */
  const added = await items.invoke(url, "items.add", { id: "it-2", kind: "map", at: 0, amount: 1 }, { write: true });
  return added.key;
}

export async function aRollupRow(): Promise<unknown> {
  /* `items.per_kind` declares a projection and the store ignores it: a rollup
     row is built from the rollup's own declaration — a count, the group
     values, one field per total — so `amount` is there although the
     projection never named it. Reading it is the whole point of this call: it
     is how a projection-shaped row for a totals would be found out. */
  const totals = await items.invoke(url, "items.per_kind", { kind: "book" });
  return totals.rows?.[0]?.amount;
}

export async function aProjectedGet(): Promise<unknown> {
  // A get returns rows, and with a projection their fields are known by name.
  const detail = await items.invoke(url, "items.detail", { id: "it-1" });
  return detail.rows?.[0]?.["nested.deep"];
}

export async function theWritesNobodyHadCompiled(): Promise<Array<number | undefined>> {
  /* put, update, delete and batch had never been through the generator in any
     test. They are here so that the four of them are calls, not output. */
  const replaced = await items.invoke(url, "items.replace", { id: "it-1", kind: "atlas", at: 1, amount: 2 }, { write: true });
  const retagged = await items.invoke(url, "items.retag", { id: "it-1", kind: "folio" }, { write: true });
  const dropped = await items.invoke(url, "items.drop", { id: "it-2" }, { write: true });
  const noted = await items.invoke(url, "items.note", { id: "it-1", kind: "folio", body: "seen" }, { write: true });
  return [replaced.changed, retagged.changed, dropped.changed, noted.changed];
}

export function anOperationName(): CoverageOperation {
  // A name the schema declares. The line in `wrong.ts` is one it does not.
  return "items.per_kind";
}

/* The old path, beside the new one and unchanged: any name, any arguments, and
   the caller saying what it expects back. Kept in this file on purpose — a
   schema-typed client must not stop existing code from compiling. */
const anything = new (Client({ transport }))();

export async function untyped(): Promise<unknown> {
  const answer = await anything.invoke<InvokeResult>(url, "whatever.you.like", { anything: true });
  return answer.rows;
}
