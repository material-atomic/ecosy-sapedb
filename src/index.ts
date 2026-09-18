/**
 * SAPEDB: a storage service addressed by a connection string.
 *
 * The root entry carries the pieces every consumer needs. Drivers, the command
 * bus and the shape registry are subpaths, so an app pulls in only what it
 * reaches for:
 *
 * ```ts
 * import { parseConnectionString } from "@ecosy/sapedb/connection";
 * import { sign } from "@ecosy/sapedb/signer";
 * import { Commander } from "@ecosy/sapedb/commander";
 * import { ShapeRegistry } from "@ecosy/sapedb/shape";
 * ```
 */

export * from "./signer";
export * from "./connection";
export * from "./errors";
