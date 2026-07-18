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

// pnpm's traced node_modules is a symlink farm into the store. The bundle must
// contain NO symlinks at all: electron-builder dereferences each link one-by-one
// into the Windows NSIS payload, which tears packages out of the store — the
// shipped copy of `next` could no longer resolve styled-jsx/react/etc. and the
// web service crash-looped on every Windows install (issue #6; verified by
// unpacking the released installer: zero symlinks, no react/styled-jsx anywhere).
// So flatten to what npm would have made: every package in the traced closure
// deref-copied as a REAL directory at the top level. Flat real dirs resolve
// identically on all OSes and keep macOS codesign happy (no links to reject).
// ponytail: assumes one version per package in the closure — true for a Next
// standalone trace; revisit if a duplicate-version package ever shows up.
const storeNM = path.join(standalone, "node_modules");
const distNM = path.join(dist, "node_modules");

// `sharp` (Next's image optimizer) is unused here and ships arch-specific native
// binaries that break the universal macOS build. Drop it from the bundle.
const isSharp = (p) => /(^|[/\\])(@img|sharp)([/\\]|$)/.test(p);

// Copy a tree following every symlink into a real copy. Guards link cycles.
function copyDeref(src, dest, anc = new Set()) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (isSharp(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    let st; try { st = fs.statSync(s); } catch { continue; } // broken link → skip
    if (st.isDirectory()) {
      const real = fs.realpathSync(s);
      if (anc.has(real)) continue;
      copyDeref(s, d, new Set(anc).add(real));
    } else fs.copyFileSync(s, d);
  }
}

// One flat node_modules: the union of the trace's direct deps (top level) and
// pnpm's hoisted virtual store (.pnpm/node_modules holds the whole transitive
// closure). Each entry deref-copies to a real dir; .pnpm itself is dropped.
function flattenNodeModules() {
  const seen = new Map(); // "name" or "@scope/name" → source dir
  const collect = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(".") || isSharp(name)) continue;
      if (name.startsWith("@")) {
        for (const sub of fs.readdirSync(path.join(dir, name))) {
          const id = `${name}/${sub}`;
          if (!isSharp(id) && !seen.has(id)) seen.set(id, path.join(dir, name, sub));
        }
      } else if (!seen.has(name)) seen.set(name, path.join(dir, name));
    }
  };
  collect(storeNM);
  collect(path.join(storeNM, ".pnpm", "node_modules"));
  for (const [id, src] of seen) {
    try { fs.realpathSync(src); } catch { continue; } // dangling link (pruned dep) → skip
    copyDeref(src, path.join(distNM, id));
  }
  console.log(`[pack-web] flattened ${seen.size} packages into node_modules`);
}

// Copy the web server tree, skipping its nested node_modules — everything
// resolves through the flat top-level one (a deref'd nested copy would only
// duplicate `next` wholesale).
function copyAppTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    let st; try { st = fs.statSync(s); } catch { continue; }
    if (st.isDirectory()) copyAppTree(s, d); else fs.copyFileSync(s, d);
  }
}

flattenNodeModules();
copyAppTree(path.join(standalone, "apps/web"), dist); // server.js + .next + package.json
// Next needs static assets + public copied alongside (standalone doesn't include them).
copyDeref(path.join(webDir, ".next/static"), path.join(dist, ".next/static"));
copyDeref(path.join(webDir, "public"), path.join(dist, "public"));

if (!fs.existsSync(path.join(dist, "server.js"))) {
  console.error("[pack-web] ERROR: server.js not found in dist/web — check the standalone output layout.");
  process.exit(1);
}
console.log("[pack-web] wrote dist/web/server.js");
