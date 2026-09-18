/**
 * The patrol that keeps the old package name from coming back.
 *
 * A rename is not "done" because a sed command ran once; it is done when
 * nothing in the tree can reintroduce the old name without this noticing.
 * Unlike the Go sibling's internal/naming, this side has no exception
 * table at all — no byte-on-disk format to protect, no derived encryption
 * key baked into anything — so every hit here is a failure, full stop.
 *
 * This file avoids spelling the old name out whole anywhere in its own
 * source (see OLD_WORD below), because this file lives inside the very
 * tree it walks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OLD_WORD = ["r", "s", "q", "l"].join("");

const SKIP_DIRS = new Set([".git", "node_modules", "dist"]);

/**
 * Reads every file under root and returns every line (case-insensitively)
 * containing OLD_WORD, no matter how deep the file is nested.
 */
function walk(root) {
  const hits = [];

  function visit(dir) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = statSync(path);

      if (info.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        visit(path);
        continue;
      }

      let content;
      try {
        content = readFileSync(path, "utf8");
      } catch {
        continue; // not text, or not readable — nothing to check either way
      }
      if (content.includes("�")) continue; // decoded with replacement characters: not real UTF-8 text

      const lower = content.toLowerCase();
      if (!lower.includes(OLD_WORD)) continue;

      const lines = content.split("\n");
      const lowerLines = lower.split("\n");
      lowerLines.forEach((lowerLine, i) => {
        if (lowerLine.includes(OLD_WORD)) {
          hits.push({ file: relative(root, path), line: i + 1, text: lines[i] });
        }
      });
    }
  }

  visit(root);
  return hits;
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

test("the old name is nowhere in this package's tree — no exception table on this side", () => {
  const hits = walk(packageRoot);
  if (hits.length > 0) {
    const lines = hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n");
    assert.fail(`the old name was found where this side of the rename allows no exceptions at all:\n${lines}`);
  }
});

// --- the patrol proving it patrols ---
//
// Everything below runs against a throwaway directory, never the real
// package, so it says nothing about whether this package is clean. It says
// whether walk() is capable of finding out.

function plant(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

test("walk finds the old name at the bottom of a deep tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "naming-patrol-"));
  try {
    const deep = join("a", "b", "c", "d", "e", "leftover.mjs");
    plant(dir, {
      [deep]: `// this still talks to ${OLD_WORD} over the wire\n`,
      "a/clean.mjs": "// nothing to see here\n",
    });

    const hits = walk(dir);
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.equal(hits[0].file, deep);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("walk is case-insensitive", () => {
  const dir = mkdtempSync(join(tmpdir(), "naming-patrol-"));
  try {
    plant(dir, {
      "shout.mjs": `// still says ${OLD_WORD.toUpperCase()} in capitals\n`,
      "title.mjs": `// and ${OLD_WORD[0].toUpperCase()}${OLD_WORD.slice(1)} in the middle of a sentence\n`,
    });

    const hits = walk(dir);
    assert.equal(hits.length, 2, JSON.stringify(hits));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("walk reports every hit, not just the first", () => {
  const dir = mkdtempSync(join(tmpdir(), "naming-patrol-"));
  try {
    plant(dir, {
      "one.mjs": `// ${OLD_WORD}\n`,
      "two.mjs": `// ${OLD_WORD}\n`,
      "multi.mjs": `// first mention of ${OLD_WORD}\n// second mention of ${OLD_WORD}\n`,
    });

    const hits = walk(dir);
    // one.mjs, two.mjs: one hit each. multi.mjs: two hits, one per line.
    assert.equal(hits.length, 4, JSON.stringify(hits));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The self-proving tests above show walk() *can* find a hit — they say
// nothing about which directories it is allowed to stop entering. Adding
// "src" to SKIP_DIRS would pass every test above unchanged, because none of
// them plant a hit inside a directory literally named src, and src/ is
// where nearly every renamed string in this package actually lives.
test("walk does not skip src", () => {
  const dir = mkdtempSync(join(tmpdir(), "naming-patrol-"));
  try {
    plant(dir, {
      "src/leftover.mjs": `// still imports ${OLD_WORD} directly\n`,
      "src/clean.mjs": "// nothing to see here\n",
    });

    const hits = walk(dir);
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.equal(hits[0].file, "src/leftover.mjs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// walk() has no line that checks a file's size before reading it, and this
// pins that absence rather than assuming it: yarn.lock (53KB) is the
// largest file in this package's real tree, and it is exactly where the old
// package name resurfaces on every dependency line that still points at it
// — so a size cutoff added to save time on "obviously not source" files
// would go silent on the one real file most likely to still carry the old
// name. The filler here is bigger than yarn.lock on purpose.
//
// The name used to claim "no size threshold", full stop — a universal claim
// this body never actually earned, since it only exercises one fixture size.
// QA measured a live mutant that skips any file over 100KB; a fixture of
// 60KB cannot see that mutant, so widening the name back to a universal
// claim would just move the same gap one level up. The name below says
// exactly what this body proves — scanning is not cut off anywhere at or
// below 61440 bytes — and this comment is the place that says what it does
// not: nothing in this file rules out a cutoff placed strictly above that
// and at or below 100KB. bait file is named .txt, not .mjs, on purpose —
// see the file-extension test below, which covers files with no recognised
// extension at all; renaming this one to end in .mjs would remove that
// accidental coverage without adding anything back.
test("walk scans a file past yarn.lock's size (61440 bytes) with no cutoff at that size", () => {
  const dir = mkdtempSync(join(tmpdir(), "naming-patrol-"));
  try {
    const filler = "x".repeat(60 * 1024); // yarn.lock is 53581 bytes
    plant(dir, {
      "big.txt": `${filler}\n// still says ${OLD_WORD} at the very end\n`,
    });

    const hits = walk(dir);
    assert.equal(hits.length, 1, JSON.stringify(hits));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The Go sibling's round-4 finding, restated for this side: every fixture
// above plants its hit inside a *.mjs file, so a mutant that filtered
// walk() down to a fixed set of extensions, or one that skipped any file
// whose name starts with ".", would pass every test above unchanged — and
// would have missed exactly the files this rename's own real work touches
// (package.json, README.md, Dockerfile-shaped config, dotfiles like
// .npmrc). This is the one place in this file the old bait file above
// (big.txt) accidentally helped: its extension is .txt, not .mjs, so the
// extension-filter mutant already died before this test existed. But that
// was luck, not a fixture built to prove it, so this test plants the same
// two shapes on purpose: a file with no recognised extension, and a hidden,
// dot-prefixed file.
test("walk scans a file with no recognised extension and a hidden, dot-prefixed file", () => {
  const dir = mkdtempSync(join(tmpdir(), "naming-patrol-"));
  try {
    plant(dir, {
      Dockerfile: `# still builds ${OLD_WORD}:latest\n`,
      ".env": `SECRET=${OLD_WORD}_fixture\n`,
      "clean.mjs": "// nothing to see here\n",
    });

    const hits = walk(dir);
    assert.equal(hits.length, 2, JSON.stringify(hits));
    const found = new Set(hits.map((h) => h.file));
    assert.ok(found.has("Dockerfile"), "a hit in a file with no recognised extension was not reported");
    assert.ok(found.has(".env"), "a hit in a hidden, dot-prefixed file was not reported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("walk does not descend into node_modules, dist, or .git", () => {
  const dir = mkdtempSync(join(tmpdir(), "naming-patrol-"));
  try {
    plant(dir, {
      [`node_modules/some-lib/${OLD_WORD}.mjs`]: `// ${OLD_WORD}\n`,
      [`dist/${OLD_WORD}.mjs`]: `// ${OLD_WORD}\n`,
      [`.git/COMMIT_EDITMSG`]: `${OLD_WORD}\n`,
      "src/clean.mjs": "// nothing to see here\n",
    });

    const hits = walk(dir);
    assert.equal(hits.length, 0, JSON.stringify(hits));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
