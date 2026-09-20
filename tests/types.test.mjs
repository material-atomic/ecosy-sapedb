/* Against the built package in dist/, the thing that ships. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { typesFor, schemaFromServer } = await import(new URL("../dist/types/index.mjs", import.meta.url).href);

const root = fileURLToPath(new URL("..", import.meta.url));
const file = (path) => fileURLToPath(new URL(path, import.meta.url));
const read = (path) => readFileSync(file(path), "utf8");

const ledgerSchema = JSON.parse(read("../fixtures/ledger.schema.json"));
const booksSchema = JSON.parse(read("./typecheck/books.schema.json"));
/* The two schemas above are real ones, and between them they declare `string`,
   `number` and five of the nine actions. Everything else the generator claims
   to handle was being generated and read by nobody. This third one is written
   for the claim rather than for an application — every argument type, every
   action, and every way a schema has of saying an argument is optional — and
   `sapedb apply` accepts it, so it is not a shape invented to make a test pass. */
const coverageSchema = JSON.parse(read("./typecheck/coverage.schema.json"));

/**
 * Compiles one of the sample projects and returns what `tsc` said.
 *
 * The compiler itself is the assertion here. Anything else — parsing the types
 * by hand, or trusting that a type that looks strict is strict — would be this
 * suite agreeing with itself about a question only `tsc` can answer.
 */
function compile(config) {
  const tsc = file("../node_modules/typescript/bin/tsc");
  const run = spawnSync(process.execPath, [tsc, "-p", file(config), "--pretty", "false"], {
    cwd: root,
    encoding: "utf8",
  });

  const reported = [];
  for (const line of `${run.stdout}${run.stderr}`.split("\n")) {
    const found = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(line);
    if (found) {
      reported.push({ file: found[1], line: Number(found[2]), code: found[3], message: found[4] });
      continue;
    }
    /* An indented line belongs to the error above it, and it is usually the
       one that names what is actually wrong: "Property 'reference' is
       missing" arrives on the second line, not the first. */
    if (/^\s+\S/.test(line) && reported.length > 0) {
      reported[reported.length - 1].message += ` ${line.trim()}`;
    }
  }
  return { status: run.status, reported, output: `${run.stdout}${run.stderr}` };
}

/** The lines of a sample file that are marked as having to be errors. */
function expectedErrorLines(path) {
  return read(path)
    .split("\n")
    .flatMap((line, at) => (line.includes("EXPECT-ERROR") && !line.trimStart().startsWith("*") ? [at + 1] : []));
}

test("the ledger fixture is the schema the Go repo ships, not a paraphrase of it", (t) => {
  /* The copy is what this package tests against, because the Go repo is a
     sibling checkout and not everyone who runs these tests has it. When it is
     there, a drift between the two is the thing worth catching: a schema
     format that moved on would otherwise be found by a user. */
  const beside = new URL("../../sapedb/examples/ledger/schema.json", import.meta.url);
  if (!existsSync(beside)) {
    // t.skip, not console.log + return: a silent return here is a
    // regression test that stopped checking anything and would not say so.
    // Until the sibling submodule directory itself is renamed to match (the
    // coordinator's job, not this package's), this is expected to skip.
    t.skip("the Go repo is not beside this one (packages/sapedb), or its directory has not been renamed yet; comparing nothing");
    return;
  }

  assert.deepEqual(
    ledgerSchema,
    JSON.parse(readFileSync(beside, "utf8")),
    "fixtures/ledger.schema.json has drifted from ../sapedb/examples/ledger/schema.json",
  );
});

test("an operation becomes its arguments, and required is what decides optional", () => {
  const source = typesFor(ledgerSchema);

  assert.match(source, /"orders\.pay": \{\n\s+args: \{\n\s+order: string;\n\s+amount: number;\n\s+at: number;\n\s+reference: string;/);
  // Not required, so it may be left out — the store fills in the declared default.
  assert.match(typesFor(booksSchema, { name: "Books" }), /since\?: number;/);
});

test("a row has a shape only where the operation declares a projection", () => {
  const books = typesFor(booksSchema, { name: "Books" });

  /* The projected paths, verbatim and each optional: the store keeps only the
     fields the document actually had, and it keys them by the declared path
     rather than nesting them. */
  assert.match(books, /row: \{\n\s+title\?: unknown;\n\s+shelf\?: unknown;\n\s+"author\.name"\?: unknown;\n\s+\};/);

  // Everything else says so rather than inventing one.
  assert.match(typesFor(ledgerSchema), /"orders\.get": \{[\s\S]*?row: Record<string, unknown>;/);
  assert.match(typesFor(ledgerSchema), /"orders\.place": \{[\s\S]*?row: never;/);
  assert.match(books, /"books\.how_many": \{\n\s+args: \{\};/);
});

/* The nine of `internal/store/ops.go`, written out here rather than read from
   the generator: a list taken from the thing under test agrees with it by
   construction. */
const EVERY_ACTION = ["get", "scan", "count", "totals", "insert", "put", "update", "delete", "batch"];

/** The generated declaration of one operation, from its name to its closing brace. */
function entryOf(source, name) {
  const found = new RegExp(`"${name.replace(/\./g, "\\.")}": \\{([\\s\\S]*?)\\n  \\};`).exec(source);
  assert.ok(found, `the generator wrote no declaration at all for ${name}`);
  return found[1];
}

test("every action an operation may declare is one the generator writes down", () => {
  /* First that the fixture still covers all nine. Without this the test keeps
     its name while proving whatever is left in the file. */
  assert.deepEqual(
    [...new Set(coverageSchema.operations.map((operation) => operation.action))].sort(),
    [...EVERY_ACTION].sort(),
    "the coverage fixture has stopped covering every action, so this test proves less than it says",
  );

  const source = typesFor(coverageSchema, { name: "Coverage" });
  for (const operation of coverageSchema.operations) {
    assert.ok(source.includes(`"${operation.name}": {`), `a ${operation.action} produced no declaration`);
  }
});

test("the four argument types a schema may declare each become the TypeScript that means the same thing", () => {
  const add = entryOf(typesFor(coverageSchema, { name: "Coverage" }), "items.add");

  assert.match(add, /\n\s+id: string;/);
  assert.match(add, /\n\s+at: number;/);
  assert.match(add, /\n\s+flag\?: boolean;/);
  /* `any` is `unknown` and not `any`: the store means "this argument is not
     checked", which leaves whoever reads the value back owing an account of
     what they think it is. `any` would hand that away silently. */
  assert.match(add, /\n\s+extra\?: unknown;/);
});

test("required is the one thing that makes an argument required, however the schema spells the rest", () => {
  const add = entryOf(typesFor(coverageSchema, { name: "Coverage" }), "items.add");

  assert.match(add, /\n\s+id: string;/, '"required": true is the only one that is required');
  assert.match(add, /\n\s+flag\?: boolean;/, '"required": false, written out, is optional');
  assert.match(add, /\n\s+extra\?: unknown;/, "no `required` at all is optional");
  assert.match(add, /\n\s+label\?: string;/, "a default is optional — the store fills it in");
});

test("a get declares the rows it sends back, and a projected get names their fields", () => {
  const detail = entryOf(typesFor(coverageSchema, { name: "Coverage" }), "items.detail");

  /* `never` is how this generator says "no rows come back", and it is not a
     harmless thing to say of a read — though not for the reason it first
     looked. `never` is assignable to everything, yes, but reading a property
     off it is a compile error (`TS2339`); it lets nothing through silently.
     Said of a get that does return rows, `never` would instead make every
     real field access on those rows fail to compile — wrong in the opposite
     direction, too strict rather than too loose. This assertion is what
     stops that: the golden `row: never;` string is forbidden for a get. */
  assert.doesNotMatch(detail, /row: never;/, "a get returns rows, and `never` says it returns none");
  assert.match(detail, /row: \{\n\s+kind\?: unknown;\n\s+"nested\.deep"\?: unknown;\n\s+\};/);
});

test("a totals row is the rollup's shape, not the projection's, even where a projection is declared", () => {
  const operation = coverageSchema.operations.find((each) => each.name === "items.per_kind");
  assert.ok(operation.projection?.length > 0, "the case only exists while this totals declares a projection");

  /* Measured, not preferred: QA ran this against a real `sapedbd` and a totals
     that declares `projection: ["kind"]` came back as `{amount, count,
     group}`. The store builds a rollup row from the rollup's declaration and
     never applies the projection to it, so a projection-shaped row here would
     be a type that contradicts the server. */
  const totals = entryOf(typesFor(coverageSchema, { name: "Coverage" }), "items.per_kind");
  assert.match(totals, /row: Record<string, unknown>;/);
  assert.doesNotMatch(totals, /row: \{/, "the projection has been applied to a rollup row the store does not project");
});

test("a schema that would generate a lie is refused rather than generated", () => {
  const operation = { name: "books.find", collection: "books", action: "get" };

  assert.throws(() => typesFor({}), TypeError);
  assert.throws(() => typesFor({ operations: [] }), TypeError);
  assert.throws(() => typesFor({ operations: [{ ...operation, name: "" }] }), TypeError);
  assert.throws(() => typesFor({ operations: [operation, operation] }), /declared twice/);
  assert.throws(() => typesFor({ operations: [{ ...operation, action: "upsert" }] }), /not something an operation can do/);
  assert.throws(
    () => typesFor({ operations: [{ ...operation, input: [{ name: "id", type: "uuid" }] }] }),
    /string, number, bool or any/,
  );
  assert.throws(() => typesFor(ledgerSchema, { name: "not an identifier" }), TypeError);
});

test("the checked-in declaration files are what the generator writes today", () => {
  const regenerate = "npm run types:fixtures";

  assert.equal(
    read("./typecheck/ledger.d.ts"),
    typesFor(ledgerSchema, { source: "fixtures/ledger.schema.json" }),
    `tests/typecheck/ledger.d.ts is stale — ${regenerate}`,
  );
  assert.equal(
    read("./typecheck/books.d.ts"),
    typesFor(booksSchema, { name: "Books", source: "tests/typecheck/books.schema.json" }),
    `tests/typecheck/books.d.ts is stale — ${regenerate}`,
  );
  assert.equal(
    read("./typecheck/coverage.d.ts"),
    typesFor(coverageSchema, { name: "Coverage", source: "tests/typecheck/coverage.schema.json" }),
    `tests/typecheck/coverage.d.ts is stale — ${regenerate}`,
  );
});

/* ---- ISS-20: the catalogue as the second source ----
 *
 * A schema does not only live in a file. A module installed over the wire —
 * `establish` for its collections, `declare` for its operations — is never
 * written to anyone's disk, and until `schemaFromServer` existed its shape had
 * to be copied by hand into whoever called it. These tests stand in for the
 * socket; tests/types-from-server.test.mjs is the one that dials a real store.
 */

const SOME_URL = "sapedb://acme:a-password-of-the-right-shape@127.0.0.1:7433/main?sig=abcd";

/** A client that answers out of an object rather than a socket. */
function reader(answers) {
  const asked = [];
  return {
    asked,
    async elevate(target, secret) {
      asked.push({ call: "elevate", target, secret });
      return { operator: answers.operator ?? true };
    },
    async explore(target, request) {
      asked.push({ call: "explore", target, request });
      if ("explored" in answers) return answers.explored;
      return { here: { operations: answers.operations } };
    },
  };
}

/** The ledger's operations in the order the store keys them: by name. */
const byName = [...ledgerSchema.operations].sort((a, b) => (a.name < b.name ? -1 : 1));

test("a catalogue reaches the generator as the schema it is, and writes the same declarations", async () => {
  /* The catalogue carries `version`, which no file does, and the operations
     arrive name-ordered rather than in the order somebody wrote them. Neither
     is invented here: both were read off a real daemon. */
  const catalogue = byName.map((operation, at) => ({ ...operation, version: at + 1 }));
  const schema = await schemaFromServer(reader({ operations: catalogue }), SOME_URL, "the-server-secret");

  assert.equal(
    typesFor(schema, { source: "somewhere" }),
    typesFor({ operations: byName }, { source: "somewhere" }),
    "a declaration read off the wire generated different text from the same declaration read off disk",
  );
});

test("the secret is proved before the catalogue is asked for, because the store will not answer otherwise", async () => {
  const client = reader({ operations: byName });
  await schemaFromServer(client, SOME_URL, "the-server-secret");

  assert.deepEqual(
    client.asked.map((each) => each.call),
    ["elevate", "explore"],
    "the catalogue was asked for without proving the secret first, which the real store refuses",
  );
  assert.equal(client.asked[0].secret, "the-server-secret");
  assert.deepEqual(client.asked[1].request, { catalogue: true });
});

test("reading a catalogue without the server's secret is refused before anything is dialled", async () => {
  const client = reader({ operations: byName });

  await assert.rejects(() => schemaFromServer(client, SOME_URL, ""), /secret/);
  await assert.rejects(() => schemaFromServer(client, SOME_URL, undefined), /secret/);
  /* Not only that it refused: that it refused without opening a connection.
     A refusal that has already dialled has already told the network that
     somebody is asking what this database holds. */
  assert.deepEqual(client.asked, [], "a call went out on the way to refusing for want of a secret");
});

test("a catalogue that is not there, or has nothing in it, is refused rather than generated", async () => {
  await assert.rejects(
    () => schemaFromServer(reader({ operator: false, operations: byName }), SOME_URL, "wrong"),
    /operator/,
  );
  await assert.rejects(() => schemaFromServer(reader({ explored: {} }), SOME_URL, "secret"), /without a catalogue/);
  /* `[]` is what a real daemon answers for a database nobody has declared
     anything in; `null` is what one from before that fix answered. Both mean
     the same thing, and neither is a malformed schema. */
  await assert.rejects(() => schemaFromServer(reader({ operations: [] }), SOME_URL, "secret"), /apply a schema/);
  await assert.rejects(() => schemaFromServer(reader({ operations: null }), SOME_URL, "secret"), /apply a schema/);
});

/** Runs the shipped bin and hands back what it wrote and what it exited with. */
function cli(args, environment = {}) {
  const run = spawnSync(process.execPath, [file("../bin/sapedb-types.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SAPEDB_SECRET: undefined, ...environment },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test("the bin still writes from a file exactly what it wrote before the second source existed", () => {
  /* The positive control, and it comes first on purpose: every refusal below
     would pass just as well against a bin that refused everything. */
  const run = cli(["fixtures/ledger.schema.json"]);

  assert.equal(run.status, 0, `the file path failed: ${run.stderr}`);
  assert.equal(run.stdout, read("./typecheck/ledger.d.ts"), "the file path no longer writes what it used to");
});

test("the bin refuses --from without a secret, and says which secret it wants", () => {
  const run = cli(["--from", SOME_URL, "--insecure"]);

  assert.equal(run.status, 1);
  assert.match(run.stderr, /--secret/);
  assert.match(run.stderr, /SAPEDB_SECRET/);
  assert.equal(run.stdout, "", "it wrote a declaration file on the way to refusing");
});

test("the bin refuses a file and a store together rather than choosing one", () => {
  /* Two sources are two schemas until something proves otherwise, and proving
     it is this program's output, not its input. */
  const run = cli(["fixtures/ledger.schema.json", "--from", SOME_URL], { SAPEDB_SECRET: "a-secret" });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /not both/);
  assert.equal(run.stdout, "");
});

test("a call the schema allows compiles", () => {
  const { status, output } = compile("./typecheck/tsconfig.right.json");

  /* The control. Without it, an `invoke` that refused every call would pass
     the test below perfectly. */
  assert.equal(output.trim(), "", `tsc reported something about calls that are correct:\n${output}`);
  assert.equal(status, 0);
});

test("a call the schema refuses does not compile", () => {
  const { status, reported } = compile("./typecheck/tsconfig.wrong.json");
  const marked = expectedErrorLines("./typecheck/wrong.ts");

  assert.ok(marked.length >= 3, "wrong.ts marks nothing, so this test proves nothing");
  assert.notEqual(status, 0, "tsc accepted a file of calls the schema refuses");

  const errored = [...new Set(reported.map((error) => error.line))].sort((a, b) => a - b);
  assert.deepEqual(
    errored,
    marked,
    "the lines tsc refused are not the lines wrong.ts says it should refuse",
  );
});

test("the three a caller gets wrong are each named by the compiler", () => {
  const { reported } = compile("./typecheck/tsconfig.wrong.json");
  const at = (line) => reported.filter((error) => error.line === line).map((error) => error.message).join(" ");
  const marked = expectedErrorLines("./typecheck/wrong.ts");

  /* Not only that these fail, but that the message tells the reader which of
     the three it was. An error that says "not assignable" and nothing else
     costs the reader the trip to the schema that this was meant to save. */
  assert.match(at(marked[0]), /"orders\.pya".*is not assignable/);
  assert.match(at(marked[0]), /"orders\.pay"/, "the message does not list the names that do exist");
  assert.match(at(marked[1]), /'reference' is missing/);
  assert.match(at(marked[2]), /Type 'string' is not assignable to type 'number'/);
});
