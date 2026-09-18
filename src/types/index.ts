/**
 * Types from a schema: the declaration file behind `Client<Schema>`.
 *
 * ```sh
 * npx rsql-types schema.json > src/rsql-schema.d.ts
 * ```
 *
 * ```ts
 * import { typesFor } from "@ecosy/rsql/types";
 *
 * const source = typesFor(JSON.parse(readFileSync("schema.json", "utf8")));
 * ```
 *
 * A schema already says everything needed to check a call before it is made:
 * which operations exist, which arguments each one takes, which of those are
 * required, and of what type. Today none of that reaches the compiler —
 * `invoke` takes a `string` and a bag of `unknown`, so a typo travels to the
 * store and comes back as a refusal. This writes the schema down as types so
 * the same typo is a compile error.
 *
 * **A generated file rather than types inferred from the JSON itself.** The
 * inferred version — importing `schema.json` with `resolveJsonModule` and
 * reading it with `as const` and conditional types — needs no build step, and
 * that is its whole advantage. What it costs is every error message: a
 * mismatch is reported against a type the compiler assembled out of the JSON,
 * which is where the reader is then sent. A generated file is a file the
 * reader can open, and its error messages name the operation and the argument.
 * The generation step is cheap; an unreadable error is not.
 *
 * **What the generated types cannot say.** A schema describes collections,
 * indexes and operations. It does not describe documents — this store
 * deliberately does not impose a shape on them — so there is nothing here from
 * which the shape of a returned document could be derived. The one exception
 * is a read with a `projection`, which names the fields that come back; there
 * the field *names* are known, though their types still are not. Everything
 * else gets `Record<string, unknown>`, which is not a gap to be filled in
 * later but the true answer to what the schema knows.
 */

/** One declared argument of an operation. */
export interface SchemaParameter {
  name: string;
  /** `string`, `number`, `bool` or `any` — the four the store declares. */
  type: string;
  required?: boolean;
  default?: unknown;
}

/**
 * One declared operation. The store's declaration carries more than this —
 * keys, bounds, documents, steps — but none of the rest changes a call's type,
 * so none of the rest is read here.
 */
export interface SchemaOperation {
  name: string;
  action: string;
  collection?: string;
  input?: readonly SchemaParameter[];
  /** The fields a read returns. Empty returns the whole document. */
  projection?: readonly string[];
}

/** A schema file, as much of it as this reads. */
export interface Schema {
  operations?: readonly SchemaOperation[];
}

export interface TypesOptions {
  /** The name of the generated interface. Default `Schema`. */
  name?: string;
  /** Where the schema came from, for the header comment. */
  source?: string;
}

/** The four argument types the store declares, as TypeScript writes them. */
const ARGUMENT_TYPES: Record<string, string> = {
  string: "string",
  number: "number",
  bool: "boolean",
  /* `any` in a schema means the store does not check this argument, which is
     `unknown` and not `any`: the caller may pass anything, and whoever reads
     it back has to say what they think it is. */
  any: "unknown",
};

/* Which actions come back with rows at all, and which of those have a shape
   the declaration can describe. A `count` returns a number; a write returns a
   key and a tally. Saying so in the type is what stops `result.rows[0]` from
   being written against an action that never sends one. */
const ROWLESS = new Set(["count", "insert", "put", "update", "delete", "batch"]);
const PROJECTABLE = new Set(["get", "scan"]);
const ACTIONS = new Set([...ROWLESS, ...PROJECTABLE, "totals"]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/* An operation name or a field path may be any non-empty string the store
   accepts, which includes plenty that is not an identifier — dots, at the very
   least, since every name in practice has one. */
function property(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** "An insert", "a batch" — the comments are read by people. */
function article(action: string): string {
  return `${/^[aeiou]/.test(action) ? "An" : "A"} ${action}`;
}

/** The row type of one operation, and the comment that says why it is that. */
function rowOf(operation: SchemaOperation, indent: string): string {
  if (ROWLESS.has(operation.action)) {
    return `${indent}/** ${article(operation.action)} sends back no rows; \`key\`, \`changed\` and \`count\` are its answer. */\n${indent}row: never;`;
  }

  if (operation.action === "totals") {
    /* A rollup row is not a document and the projection is not applied to it:
       the store builds it from the rollup's own declaration — a count, the
       group values, and one field per total. That shape is knowable, but from
       the collection's rollup rather than from the operation, which is a
       different reading of a different part of the schema than this does. */
    return `${indent}/** A rollup row: a count, the group values, and one field per declared total. The rollup says which; this does not read it. */\n${indent}row: Record<string, unknown>;`;
  }

  const projection = operation.projection ?? [];
  if (projection.length === 0) {
    return `${indent}/** The schema does not describe documents, so the shape of this row is genuinely not known here. */\n${indent}row: Record<string, unknown>;`;
  }

  /* Every projected field is optional because the store keeps only the ones the
     document actually had — a projection is not a promise that the field is
     there. And the key is the declared path verbatim: a projection of "a.b"
     comes back under the key "a.b", not as nested objects. */
  const fields = projection.map((path) => `${indent}  ${property(path)}?: unknown;`).join("\n");
  return [
    `${indent}/**`,
    `${indent} * The projected fields. Each is optional: the store keeps only those the`,
    `${indent} * document had. Each is \`unknown\`: the schema names the fields, never`,
    `${indent} * their types. The key is the declared path verbatim, not a nested path.`,
    `${indent} */`,
    `${indent}row: {`,
    fields,
    `${indent}};`,
  ].join("\n");
}

function argsOf(operation: SchemaOperation, indent: string): string {
  const input = operation.input ?? [];
  if (input.length === 0) {
    /* Not `Record<string, never>`: that would make the argument object
       required for an operation that takes nothing. `{}` with no members both
       lets the call leave it out and refuses any property put in it. */
    return `${indent}args: {};`;
  }

  const lines = input.map((parameter) => {
    const type = ARGUMENT_TYPES[parameter.type];
    if (!type) {
      throw new TypeError(
        `[ecosy/rsql] ${operation.name} declares ${parameter.name} as "${parameter.type}", and an argument is string, number, bool or any`,
      );
    }
    /* Required is what the store checks for, and it is not the same as having
       no default: an argument with a default may be left out, and one with
       neither may also be left out and simply arrives unset. */
    const optional = parameter.required ? "" : "?";
    return `${indent}  ${property(parameter.name)}${optional}: ${type};`;
  });

  return [`${indent}args: {`, ...lines, `${indent}};`].join("\n");
}

function describe(operation: SchemaOperation): string {
  const where = operation.collection ? ` on \`${operation.collection}\`` : "";
  return `  /** \`${operation.action}\`${where}. */`;
}

/**
 * Writes a schema down as TypeScript.
 *
 * Refuses rather than guesses: an operation with no name, an action the store
 * does not have, an argument type it does not declare, or two operations of
 * one name would each produce a declaration file that lies about what the
 * store will accept, which is worse than having none.
 */
export function typesFor(schema: Schema, options: TypesOptions = {}): string {
  const name = options.name ?? "Schema";
  if (!IDENTIFIER.test(name)) {
    throw new TypeError(`[ecosy/rsql] "${name}" cannot be the name of a generated type`);
  }

  const operations = schema?.operations;
  if (!Array.isArray(operations)) {
    throw new TypeError("[ecosy/rsql] a schema declares its operations in an `operations` array");
  }
  if (operations.length === 0) {
    throw new TypeError("[ecosy/rsql] the schema declares no operations, so there is nothing to call");
  }

  const seen = new Set<string>();
  const entries = operations.map((operation) => {
    if (typeof operation?.name !== "string" || operation.name.length === 0) {
      throw new TypeError("[ecosy/rsql] an operation with no name");
    }
    if (seen.has(operation.name)) {
      throw new TypeError(`[ecosy/rsql] "${operation.name}" is declared twice`);
    }
    seen.add(operation.name);

    if (!ACTIONS.has(operation.action)) {
      throw new TypeError(`[ecosy/rsql] "${operation.name}" does "${operation.action}", which is not something an operation can do`);
    }

    return [
      describe(operation),
      `  ${property(operation.name)}: {`,
      argsOf(operation, "    "),
      rowOf(operation, "    "),
      "  };",
    ].join("\n");
  });

  const from = options.source ? ` from ${options.source}` : "";

  return `${[
    "/**",
    ` * Generated by rsql-types${from}. Do not edit: regenerate it instead.`,
    " *",
    " * Every operation the schema declares, with what it takes and what a row of",
    " * its answer is. `row` is `Record<string, unknown>` wherever the schema does",
    " * not describe the document — which is everywhere but a read with a declared",
    " * projection, because this store does not impose a shape on documents. That",
    " * is the schema's true answer, not a gap waiting to be filled.",
    " */",
    "",
    `export interface ${name} {`,
    entries.join("\n\n"),
    "}",
    "",
    `/** Every operation name the schema declares. */`,
    `export type ${name}Operation = keyof ${name};`,
  ].join("\n")}\n`;
}
