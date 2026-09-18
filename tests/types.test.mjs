/* Against the built package in dist/, the thing that ships. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { typesFor } = await import(new URL("../dist/types/index.mjs", import.meta.url).href);

const root = fileURLToPath(new URL("..", import.meta.url));
const file = (path) => fileURLToPath(new URL(path, import.meta.url));
const read = (path) => readFileSync(file(path), "utf8");

const ledgerSchema = JSON.parse(read("../fixtures/ledger.schema.json"));
const booksSchema = JSON.parse(read("./typecheck/books.schema.json"));

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

test("the ledger fixture is the schema the Go repo ships, not a paraphrase of it", () => {
  /* The copy is what this package tests against, because the Go repo is a
     sibling checkout and not everyone who runs these tests has it. When it is
     there, a drift between the two is the thing worth catching: a schema
     format that moved on would otherwise be found by a user. */
  const beside = new URL("../../rsql/examples/ledger/schema.json", import.meta.url);
  if (!existsSync(beside)) {
    console.log("    (the Go repo is not beside this one; comparing nothing)");
    return;
  }

  assert.deepEqual(
    ledgerSchema,
    JSON.parse(readFileSync(beside, "utf8")),
    "fixtures/ledger.schema.json has drifted from ../rsql/examples/ledger/schema.json",
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
