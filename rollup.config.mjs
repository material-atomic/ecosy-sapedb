import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";
import path from "path";
import { glob } from "glob";

// Get all TypeScript files in src, excluding test files
const inputFiles = glob.sync("src/**/*.{ts,tsx}", {
  ignore: ["src/**/*.test.{ts,tsx}", "src/**/*.spec.{ts,tsx}", "**/vitest.setup.ts"],
});

// Create input object with file names as keys and paths as values
const input = inputFiles.reduce((acc, file) => {
  const relativePath = path.relative("src", file);
  const key = relativePath.replace(path.extname(relativePath), "");
  acc[key] = file;
  return acc;
}, {});

/* Node's own modules, and nothing else. The `./node` subpath imports them on
   purpose; bundling them would make a build that cannot run anywhere else fail
   at the import rather than at the first connection, which is the point. */
const external = [/^node:/];

// Minification configuration
const minifyOptions = {
  compress: {
    /* Named methods, not `true`. Dropping every console call took
       `console.warn` with it — including the cache's default onError — so a
       failed cache write in the build everyone installs said nothing at all.
       Diagnostics stay; chatter goes. */
    drop_console: ["log", "info", "debug"],
    drop_debugger: true,
    pure_funcs: ["console.log", "console.info", "console.debug"],
  },
  mangle: true,
};

// CommonJS build
const cjsConfig = {
  input,
  external,
  output: {
    dir: "dist",
    format: "cjs",
    entryFileNames: "[name].js",
    chunkFileNames: "[name].js",
    exports: "named",
    preserveModules: true,
    preserveModulesRoot: "src",
    interop: "auto",
  },
  plugins: [
    typescript({
      tsconfig: "./tsconfig.json",
      declaration: true,
      declarationDir: "dist",
      rootDir: "src",
    }),
    terser(minifyOptions),
  ],
};

// ESM build
const esmConfig = {
  input,
  external,
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "[name].mjs",
    exports: "named",
    preserveModules: true,
    preserveModulesRoot: "src",
    interop: "auto",
    generatedCode: {
      symbols: true,
    },
  },
  plugins: [
    typescript({
      tsconfig: "./tsconfig.json",
      declaration: false,
      declarationDir: undefined,
      rootDir: "src",
    }),
    terser(minifyOptions),
  ],
};

// UMD build (Standalone for browsers)
export default [cjsConfig, esmConfig];
