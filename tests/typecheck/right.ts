/**
 * The calls a schema allows. `tsc` must report nothing at all in this file.
 *
 * It is the control for `wrong.ts`: without it, a typed `invoke` that refused
 * everything would pass that suite perfectly. The two files make the same
 * calls, one of them correctly.
 */

import { Client, type InvokeResult, type Transport } from "@ecosy/rsql/client";

import type { Books } from "./books";
import type { Schema } from "./ledger";

declare const transport: Transport;
declare const url: string;

const ledger = new (Client<Schema>({ transport, mode: "bound" }))();
const library = new (Client<Books>({ transport, storageKey: "books" }))();

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

/* The old path, beside the new one and unchanged: any name, any arguments, and
   the caller saying what it expects back. Kept in this file on purpose — a
   schema-typed client must not stop existing code from compiling. */
const anything = new (Client({ transport }))();

export async function untyped(): Promise<unknown> {
  const answer = await anything.invoke<InvokeResult>(url, "whatever.you.like", { anything: true });
  return answer.rows;
}
