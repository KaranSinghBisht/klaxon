import { defineConfig } from "tsup";

/**
 * `target: "node22"` is load-bearing, not cosmetic: at a bare ES target esbuild rewrites
 * `import "node:sqlite"` to `import "sqlite"`, and `node:sqlite` is prefix-only — the bundle then
 * dies at startup with ERR_MODULE_NOT_FOUND. The image runs Node 24; 22 is the floor the lockfile
 * and `engines` already declare.
 *
 * `db/schema.sql` is copied next to the bundle by the `build` script, so
 * `new URL("./schema.sql", import.meta.url)` resolves in `dist/` exactly as it does in `src/`.
 */
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  sourcemap: true,
  // tsup 8 strips `node:` prefixes by default. `node:sqlite` is prefix-only, so a stripped bundle
  // dies at startup with `Cannot find package 'sqlite'`.
  removeNodeProtocol: false,
});
