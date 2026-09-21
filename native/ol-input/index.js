"use strict";
// Loads the compiled addon. Node only dlopens files named `.node`, so
// scripts/build.cjs stages the cargo artifact under this name.
const fs = require("node:fs");
const path = require("node:path");

const candidates = [
  process.env.OL_INPUT_BINARY,
  path.join(__dirname, `ol-input.${process.platform}-${process.arch}.node`),
].filter(Boolean);

const found = candidates.find((candidate) => fs.existsSync(candidate));
if (!found) {
  throw new Error(
    `ol-input native addon not built. Run \`pnpm --filter @openlive/ol-input build\`. Looked in:\n  ${candidates.join("\n  ")}`,
  );
}

module.exports = require(found);
