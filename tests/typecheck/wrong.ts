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
import type { Schema } from "./ledger";

declare const transport: Transport;
declare const url: string;

const ledger = new (Client<Schema>({ transport, mode: "bound" }))();
const library = new (Client<Books>({ transport, storageKey: "books" }))();

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
