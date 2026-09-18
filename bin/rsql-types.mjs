#!/usr/bin/env node
/**
 * Writes a schema down as TypeScript, on stdout.
 *
 *     npx rsql-types schema.json > src/rsql-schema.d.ts
 *     npx rsql-types schema.json --name LedgerSchema
 *
 * Hand-written rather than built, and deliberately: a bin needs a shebang and
 * a stable path, and the build here preserves modules rather than making
 * bundles, so a generated entry point would be one more thing that can be
 * wrong in a published package for no gain. Everything it does beyond reading
 * a file lives in `@ecosy/rsql/types`, where it can be tested without a
 * process.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { typesFor } from "../dist/types/index.mjs";

const USAGE = "usage: rsql-types <schema.json> [--name Schema]";

function fail(message) {
  process.stderr.write(`rsql-types: ${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let file = null;
let name;

for (let at = 0; at < argv.length; at++) {
  const argument = argv[at];

  if (argument === "--help" || argument === "-h") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  if (argument === "--name") {
    name = argv[++at];
    if (name === undefined) fail(`--name needs a name\n${USAGE}`);
    continue;
  }

  if (argument.startsWith("--name=")) {
    name = argument.slice("--name=".length);
    continue;
  }

  if (argument.startsWith("-")) fail(`unknown option ${argument}\n${USAGE}`);

  /* One schema, not several. Two files' operations merged into one interface
     would silently make a type for a store that does not exist. */
  if (file !== null) fail(`one schema at a time\n${USAGE}`);
  file = argument;
}

if (file === null) fail(USAGE);

const path = resolve(file);

let schema;
try {
  schema = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  fail(`${path}: ${error.message}`);
}

try {
  /* The path as it was typed, not as it resolved: the header is read by
     whoever has to regenerate the file, and an absolute path from another
     machine tells them nothing. */
  process.stdout.write(typesFor(schema, { name, source: file }));
} catch (error) {
  fail(error.message);
}
