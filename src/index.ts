/**
 * RSQL: a storage service addressed by a connection string.
 *
 * The root entry carries the pieces every consumer needs. Drivers, the command
 * bus and the shape registry are subpaths, so an app pulls in only what it
 * reaches for:
 *
 * ```ts
 * import { parseConnectionString } from "@ecosy/rsql/connection";
 * import { sign } from "@ecosy/rsql/signer";
 * import { Commander } from "@ecosy/rsql/commander";
 * import { ShapeRegistry } from "@ecosy/rsql/shape";
 * ```
 */

export * from "./signer";
export * from "./connection";
export * from "./errors";
