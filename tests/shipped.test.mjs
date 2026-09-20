import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const manifest = require("../package.json");

/* What npm would actually put in the tarball, asked of npm rather than
   guessed from the `files` list -- `files` is not the whole story, since npm
   attaches README and LICENSE on its own and prunes other things. */
function shipped() {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }));
  return packed[0].files.map((entry) => entry.path);
}

test("the conformance fixtures are shipped", () => {
  const files = shipped();
  // A positive control first: if this list is empty or malformed, every
  // assertion below would pass by vacuum rather than by agreement.
  assert.ok(files.length > 10, `npm pack listed ${files.length} files, which is too few to be this package`);
  for (const fixture of ["fixtures/signing.json", "fixtures/frames.json"]) {
    assert.ok(files.includes(fixture), `${fixture} is not in the tarball, so no other implementation can read it`);
  }
});

test("a fixture that ships is a fixture a caller can reach", () => {
  const files = shipped().filter((path) => path.startsWith("fixtures/"));
  assert.ok(files.length >= 2, `only ${files.length} fixtures ship, which is fewer than this package has`);

  /* frames.json shipped for a while without an exports entry. It was in the
     tarball and unreachable: Node resolves a subpath through the exports map
     and refuses anything the map does not name, so `@ecosy/sapedb/fixtures/
     frames.json` threw ERR_PACKAGE_PATH_NOT_EXPORTED on a file that was
     sitting right there. Shipping and reaching are two facts, and nothing
     was comparing them. */
  for (const path of files) {
    const subpath = `./${path}`;
    assert.ok(
      Object.hasOwn(manifest.exports, subpath),
      `${path} ships but package.json exports does not name it, so an importer cannot read the file it just downloaded`,
    );
    const target = manifest.exports[subpath];
    assert.equal(target, subpath, `${subpath} should export itself, not ${target}`);
    assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} is exported but not on disk`);
  }
});

test("the frames fixture is the one the server repository holds, when it is beside this one", (t) => {
  const beside = new URL("../../sapedb/fixtures/frames.json", import.meta.url);
  if (!existsSync(beside)) {
    t.skip("the Go repo is not beside this one; comparing nothing");
    return;
  }
  /* The two repositories keep byte-identical copies by hand and nothing
     compares them. A drift window of ten minutes has already gone unnoticed
     by both suites. This is the comparison, for whoever has both checkouts. */
  assert.equal(
    readFileSync(new URL("../fixtures/frames.json", import.meta.url), "utf8"),
    readFileSync(beside, "utf8"),
    "fixtures/frames.json has drifted from ../sapedb/fixtures/frames.json",
  );
});
