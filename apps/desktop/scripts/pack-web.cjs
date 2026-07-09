"use strict";
// Build the Next.js app as a self-contained "standalone" server and assemble it
// into dist/web/ so the Electron app can run `node dist/web/server.js`.
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..", "..");
const webDir = path.join(root, "apps/web");
const standalone = path.join(webDir, ".next", "standalone");
const dist = path.resolve(__dirname, "..", "dist", "web");

// 1. Build. Bake the agent's ws URL so the renderer connects straight to the
//    local agent (no proxy), and force a production build.
console.log("[pack-web] next build (standalone)…");
execSync("pnpm --filter @openlive/web build", {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production", NEXT_PUBLIC_LIVE_WS_URL: "ws://localhost:47823" },
});

// 2. Assemble a flat dist/web where server.js sits at the root next to
//    node_modules + .next + static + public.
console.log("[pack-web] assembling dist/web…");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const cp = (from, to) => { if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true }); };

// Standalone root: node_modules (traced) + the monorepo tree with server.js at
// apps/web/server.js. Copy the traced node_modules to dist root, and the web
// server tree flattened to dist root.
cp(path.join(standalone, "node_modules"), path.join(dist, "node_modules"));
cp(path.join(standalone, "apps/web"), dist); // brings server.js + .next + package.json
// Next needs static assets + public copied alongside (standalone doesn't include them).
cp(path.join(webDir, ".next/static"), path.join(dist, ".next/static"));
cp(path.join(webDir, "public"), path.join(dist, "public"));

// pnpm's node_modules is a symlink farm and Next's standalone tracer leaves some
// intermediate .pnpm symlinks dangling in the copy (their real target lives
// elsewhere, so the app runs fine). macOS code-signing stat()s every file in the
// bundle and dies on a broken link — prune them. Recurse only into real dirs so
// pnpm's symlink cycles can't loop us.
function pruneBrokenSymlinks(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      if (!fs.existsSync(p)) fs.rmSync(p, { force: true }); // existsSync follows the link
    } else if (entry.isDirectory()) {
      pruneBrokenSymlinks(p);
    }
  }
}
const nm = path.join(dist, "node_modules");
if (fs.existsSync(nm)) pruneBrokenSymlinks(nm);

if (!fs.existsSync(path.join(dist, "server.js"))) {
  console.error("[pack-web] ERROR: server.js not found in dist/web — check the standalone output layout.");
  process.exit(1);
}
console.log("[pack-web] wrote dist/web/server.js");
