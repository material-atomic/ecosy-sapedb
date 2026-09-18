/**
 * The calls a schema refuses. Every line marked `EXPECT-ERROR` must be an
 * error, and no other line may be — `tests/types.test.mjs` compiles this file
 * and compares the lines `tsc` reported against the lines marked here.
 *
 * Each wrong call is written on one line so that the line `tsc` names is the
 * line the marker is on, whichever part of the call it decides to blame.
 */

import { Client, type Transport } from "@ecosy/rsql/client";

import type { Books } from "./books";
import type { Coverage, CoverageOperation } from "./coverage";
import type { Schema } from "./ledger";

declare const transport: Transport;
declare const url: string;

const ledger = new (Client<Schema>({ transport, mode: "bound" }))();
const library = new (Client<Books>({ transport, storageKey: "books" }))();
const items = new (Client<Coverage>({ transport, mode: "bound" }))();

export async function typos(): Promise<void> {
  await ledger.invoke(url, "orders.pya", { order: "ord-1", amount: 249.5, at: 1, reference: "bank-ref" }); // EXPECT-ERROR an operation the schema does not declare
  await ledger.invoke(url, "orders.pay", { order: "ord-1", amount: 249.5, at: 1 }); // EXPECT-ERROR a required argument left out
  await ledger.invoke(url, "orders.pay", { order: "ord-1", amount: "249.50", at: 1, reference: "bank-ref" }); // EXPECT-ERROR an argument of the wrong type
  await ledger.invoke(url, "orders.pay", { order: "ord-1", amount: 249.5, at: 1, reference: "bank-ref", currency: "VND" }); // EXPECT-ERROR an argument the operation does not take
  await ledger.invoke(url, "orders.get"); // EXPECT-ERROR the argument object left out where the operation needs one
}

export async function rows(): Promise<void> {
  const shelf = await library.invoke(url, "books.on_shelf", { shelf: "history" });
  shelf.rows?.[0]?.author; // EXPECT-ERROR a field the projection does not name
}

export async function aBoolIsNotAString(): Promise<void> {
  // The only bool any fixture declares. Written down as a string it would take this.
  await items.invoke(url, "items.add", { id: "it-1", kind: "book", at: 0, amount: 1, flag: "yes" }); // EXPECT-ERROR a bool argument given a string
}

export async function aProjectedGetHasRows(): Promise<void> {
  /* A get sends rows back and the projection says which fields they carry.
     Were a get written down as sending none, `row` would be `never` — which
     is assignable to everything, but reading a property off it is still a
     compile error (`TS2339`), not a free pass to read anything. This line
     stays red either way, for the same reason it is red now, so it does not
     exercise that mutation; the get-rowless case is bitten by a named
     assertion in `tests/types.test.mjs`, not by this file. */
  const detail = await items.invoke(url, "items.detail", { id: "it-1" });
  detail.rows?.[0]?.amount; // EXPECT-ERROR a field the projection does not name, on a read that does return rows
}

/* `any` in a schema is `unknown` here, not `any`: the store says it does not
   check this argument, which makes whoever reads the value back responsible
   for saying what they think it is. `any` would let this assignment through
   and would do it silently, which is the difference worth a line. */
declare const anAnyArgument: Coverage["items.add"]["args"]["extra"];
export const asString: string = anAnyArgument; // EXPECT-ERROR an unchecked argument read back as a string without a word about why

export const notAnOperation: CoverageOperation = "items.per_king"; // EXPECT-ERROR a name the schema does not declare
