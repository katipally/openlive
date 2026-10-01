"use strict";
// Whether the staged addon still matches its sources. A content hash, not
// mtimes: a checkout or a fresh worktree gives every file a new mtime, and a
// branch switch can hand back an old one.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const INPUTS = ["Cargo.toml", "Cargo.lock", "build.rs", "src", "scripts/build.cjs"];

/** Every input file under `root`, sorted so the walk order never changes the hash. O(n log n) in files. */
function inputFiles(root, inputs) {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    if (!fs.statSync(abs).isDirectory()) { files.push(rel); return; }
    for (const name of fs.readdirSync(abs)) walk(path.join(rel, name));
  };
  inputs.forEach(walk);
  return files.map((f) => f.split(path.sep).join("/")).sort();
}

/** `inputs`: the files and folders under `root` the binary is built from. */
function sourceHash(root, inputs = INPUTS) {
  const hash = crypto.createHash("sha256");
  for (const rel of inputFiles(root, inputs)) {
    hash.update(`${rel}\0`);
    hash.update(fs.readFileSync(path.join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** The hash of the sources the binary at `binary` was built from, kept in the gitignored target/. */
const stampPath = (root, binary) => path.join(root, "target", `${path.basename(binary)}.sha256`);

/** Why `binary` has to be built, or null when it is current. Pure: the caller reads the disk. */
function staleReason({ binaryExists, stamp, hash }) {
  if (!binaryExists) return "not built yet";
  if (!stamp) return "no record of what it was built from";
  if (stamp.trim() !== hash) return "sources changed";
  return null;
}

function readStamp(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

module.exports = { sourceHash, stampPath, staleReason, readStamp };
