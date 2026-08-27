import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/vigil.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  define: { __VIGIL_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: "#!/usr/bin/env node" },
  minify: true,
  sourcemap: false,
  legalComments: "none",
});

console.log(`built dist/vigil.mjs (v${pkg.version})`);
