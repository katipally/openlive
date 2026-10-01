"use strict";
// Writes apps/desktop/telemetry/schema.json from the TypeScript schema, the one
// source of truth in packages/shared. Main is plain CJS and cannot import that
// package, so it reads this copy; a test fails when the two differ.
//   node apps/desktop/scripts/gen-telemetry-schema.cjs
const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const entry = path.resolve(__dirname, "..", "..", "..", "packages", "shared", "src", "telemetry-schema.ts");
const out = path.resolve(__dirname, "..", "telemetry", "schema.json");

// Enum lists and leaf objects stay on one line, so the file reads as a table and diffs as one.
const isScalar = (v) => v === null || typeof v !== "object";
const isList = (v) => Array.isArray(v) && v.every(isScalar);
const inline = (v) => (isList(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : JSON.stringify(v));
const format = (v, pad = "") => {
  if (isScalar(v) || isList(v)) return inline(v);
  const entries = Object.entries(v).map(([k, x]) => [JSON.stringify(k), x]);
  if (entries.every(([, x]) => isScalar(x) || isList(x))) return `{ ${entries.map(([k, x]) => `${k}: ${inline(x)}`).join(", ")} }`;
  return `{\n${entries.map(([k, x]) => `${pad}  ${k}: ${format(x, `${pad}  `)}`).join(",\n")}\n${pad}}`;
};

async function main() {
  const { outputFiles } = await esbuild.build({
    entryPoints: [entry], bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent",
  });
  const code = Buffer.from(outputFiles[0].text).toString("base64");
  const { telemetrySchema } = await import(`data:text/javascript;base64,${code}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${format(telemetrySchema)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
