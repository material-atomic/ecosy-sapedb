#!/usr/bin/env node
/**
 * Writes a schema down as TypeScript, on stdout.
 *
 *     npx sapedb-types schema.json > src/sapedb-schema.d.ts
 *     npx sapedb-types schema.json --name LedgerSchema
 *
 * Or from the store that is holding the schema, with no file anywhere:
 *
 *     npx sapedb-types --from 'sapedb://acme:pw@host:7433/main?sig=…' --secret "$SAPEDB_SECRET"
 *
 * The second path exists because a schema does not only live in a file. A
 * module installed over the wire — `establish` for its collections, `declare`
 * for its operations — is never written to anyone's disk, so until this
 * existed the only way to get its shape into a caller's tree was to copy it
 * there by hand. The store already answers `WhatIsHere` with every
 * declaration it holds; this reads that and runs it through the same
 * generator.
 *
 * Hand-written rather than built, and deliberately: a bin needs a shebang and
 * a stable path, and the build here preserves modules rather than making
 * bundles, so a generated entry point would be one more thing that can be
 * wrong in a published package for no gain. Everything it does beyond reading
 * a file, or opening a socket, lives in `@ecosy/sapedb/types`, where it can be
 * tested without a process.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { typesFor, schemaFromServer } from "../dist/types/index.mjs";

const USAGE = [
  "usage: sapedb-types <schema.json> [--name Schema]",
  "       sapedb-types --from <connection-string> [--secret SECRET] [--insecure] [--name Schema]",
  "",
  "  --from      read the catalogue of a running store instead of a file",
  "  --secret    the server's own secret; SAPEDB_SECRET is used when this is absent",
  "  --insecure  speak plain TCP, for a store reached over a network already private",
].join("\n");

function fail(message) {
  process.stderr.write(`sapedb-types: ${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let file = null;
let name;
let from;
let secret;
let insecure = false;

/** `--flag value` and `--flag=value`, for the options that take one. */
function valued(argument, flag, at) {
  if (argument === flag) {
    const value = argv[at + 1];
    if (value === undefined) fail(`${flag} needs a value\n${USAGE}`);
    return { value, skip: 1 };
  }
  if (argument.startsWith(`${flag}=`)) return { value: argument.slice(flag.length + 1), skip: 0 };
  return null;
}

for (let at = 0; at < argv.length; at++) {
  const argument = argv[at];

  if (argument === "--help" || argument === "-h") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const named = valued(argument, "--name", at);
  if (named) {
    name = named.value;
    at += named.skip;
    continue;
  }

  const source = valued(argument, "--from", at);
  if (source) {
    from = source.value;
    at += source.skip;
    continue;
  }

  const given = valued(argument, "--secret", at);
  if (given) {
    secret = given.value;
    at += given.skip;
    continue;
  }

  if (argument === "--insecure") {
    insecure = true;
    continue;
  }

  if (argument.startsWith("-")) fail(`unknown option ${argument}\n${USAGE}`);

  /* One schema, not several. Two files' operations merged into one interface
     would silently make a type for a store that does not exist. */
  if (file !== null) fail(`one schema at a time\n${USAGE}`);
  file = argument;
}

/* A file and a server are two different schemas until something proves they
   are not, and proving it is this program's output, not its input. Picking one
   silently would generate from a source the caller did not mean. */
if (file !== null && from !== undefined) fail(`a schema file or --from, not both\n${USAGE}`);
if (file === null && from === undefined) fail(USAGE);

/**
 * The generated text, from whichever source was asked for.
 *
 * `source` is what the header comment names, and it is read by whoever has to
 * regenerate the file. For a file that is the path as it was typed, not as it
 * resolved: an absolute path from another machine tells them nothing. For a
 * store it is the connection string with the password and the signature taken
 * out — the header is committed, and a generated file is the last place a
 * credential should end up.
 */
async function generate() {
  if (from !== undefined) {
    /* Imported here, not at the top: the file path must keep working where
       `node:tls` does not exist, and `@ecosy/sapedb/node` fails loudly at the
       import rather than quietly at the first connection. */
    const [{ Client }, { nodeTransport }, { redact }] = await Promise.all([
      import("../dist/client/index.mjs"),
      import("../dist/node/index.mjs"),
      import("../dist/connection/index.mjs"),
    ]);

    const proof = secret ?? process.env.SAPEDB_SECRET;
    if (!proof) {
      fail(
        "reading a catalogue needs the server's own secret: pass --secret, or set SAPEDB_SECRET.\n" +
          "The store answers WhatIsHere only to a connection that has proved it operates the server; a connection string alone does not open it.",
      );
    }

    /* `bound`, because this dials one database, once. The database is fixed at
       the handshake and no call names another. */
    const Made = Client({ transport: nodeTransport({ insecure }), mode: "bound" });
    const client = new Made();
    try {
      const schema = await schemaFromServer(client, from, proof);
      return typesFor(schema, { name, source: redact(from) });
    } finally {
      await client.close();
    }
  }

  const path = resolve(file);
  let schema;
  try {
    schema = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${path}: ${error.message}`);
  }
  return typesFor(schema, { name, source: file });
}

try {
  process.stdout.write(await generate());
} catch (error) {
  fail(error.message);
}
