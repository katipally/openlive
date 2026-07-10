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

// pnpm's node_modules is a symlink farm and Next writes those links as ABSOLUTE
// paths into the build machine's pnpm store. Copied verbatim they (a) point
// outside the .app so macOS codesign rejects them ("invalid destination for
// symbolic link in bundle") and (b) break at runtime on any machine lacking that
// path. But the links themselves are load-bearing — pnpm resolves a package's
// deps through them — so we can't just deref (that breaks resolution). Instead we
// rewrite each in-store link as a RELATIVE path pointing inside the bundle:
// codesign-clean, portable, and resolution-preserving.
const storeNM = path.join(standalone, "node_modules"); // link targets live under here
const distNM = path.join(dist, "node_modules");        // and get rebased to here

// Follow a symlink to its final real target and copy that content (only used for
// links that escape the store, e.g. workspace packages). Guards cycles.
function copyDeref(src, dest, anc = new Set()) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    let st; try { st = fs.statSync(s); } catch { continue; }
    if (st.isDirectory()) {
      const real = fs.realpathSync(s);
      if (anc.has(real)) continue;
      copyDeref(s, d, new Set(anc).add(real));
    } else fs.copyFileSync(s, d);
  }
}

// `sharp` (Next's image optimizer) is unused here and ships arch-specific native
// binaries that break the universal macOS build. Drop it from the bundle.
const isSharp = (p) => /[/\\](@img|sharp)([/\\]|$)/.test(p) || /[/\\]\.pnpm[/\\](@img\+|sharp@)/.test(p);

function mirror(src, dest) {
  if (isSharp(dest)) return;
  const lst = fs.lstatSync(src);
  if (lst.isSymbolicLink()) {
    let real; try { real = fs.realpathSync(src); } catch { return; } // broken → skip
    const rel = path.relative(storeNM, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      copyDeref(real, dest);                          // escapes the store → deref
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const target = path.relative(path.dirname(dest), path.join(distNM, rel));
      try { fs.rmSync(dest, { force: true }); } catch {}
      fs.symlinkSync(target, dest);                   // relative, in-bundle
    }
  } else if (lst.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) mirror(path.join(src, name), path.join(dest, name));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}
const cp = (from, to) => { if (fs.existsSync(from)) mirror(from, to); };

// Standalone root: node_modules (traced) + the monorepo tree with server.js at
// apps/web/server.js. Copy the traced node_modules to dist root, and the web
// server tree flattened to dist root.
cp(path.join(standalone, "node_modules"), path.join(dist, "node_modules"));
cp(path.join(standalone, "apps/web"), dist); // brings server.js + .next + package.json
// Next needs static assets + public copied alongside (standalone doesn't include them).
cp(path.join(webDir, ".next/static"), path.join(dist, ".next/static"));
cp(path.join(webDir, "public"), path.join(dist, "public"));

if (!fs.existsSync(path.join(dist, "server.js"))) {
  console.error("[pack-web] ERROR: server.js not found in dist/web — check the standalone output layout.");
  process.exit(1);
}
console.log("[pack-web] wrote dist/web/server.js");
