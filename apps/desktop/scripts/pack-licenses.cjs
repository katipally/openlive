"use strict";
// Write dist/THIRD_PARTY_LICENSES.txt: every open-source library inside the
// installer, with its SPDX license, license text and (Apache-2.0) NOTICE text.
// Runs after pack-web, pack-agent and pack-native and reads what they staged:
//   web     the staged dist/web/node_modules, plus the production closure of
//           apps/web, because Next compiles those libraries into .next/ chunks
//   agent   the staged dist/agent/node_modules, plus every library esbuild
//           inlined into agent.mjs (dist/agent-inputs.json, written by pack-agent)
//   native  the Rust crates linked into the ol-input addon and the helper
// Exits non-zero, writing nothing, when a license text is missing or a license is
// not on the allowlist, so a new copyleft dependency cannot reach an installer.
// Extra licenses are opted into per build: pack-licenses.cjs --allow=MPL-2.0
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..", "..");
const dist = path.resolve(__dirname, "..", "dist");
const out = path.join(dist, "THIRD_PARTY_LICENSES.txt");

const ALLOWED = new Set([
  "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "BlueOak-1.0.0",
  "CC0-1.0", "Zlib", "Unlicense", "Python-2.0", "CC-BY-4.0",
  ...(process.argv.find((a) => a.startsWith("--allow=")) ?? "").slice(8).split(",").filter(Boolean),
]);

// GSAP's license is its own "no charge" terms, published at a URL and not as a
// file: neither package ships a license file. Allowed by name, and only while
// the package still points at those terms, so a changed license is noticed.
const GSAP_TERMS = "https://gsap.com/standard-license";
const CUSTOM = { gsap: "LicenseRef-GSAP-Standard", "@gsap/react": "LicenseRef-GSAP-Standard" };
ALLOWED.add("LicenseRef-GSAP-Standard");

// Same rule as pack-web: sharp and its binaries are stripped from the bundle.
const isSharp = (p) => /(^|[/\\])(@img|sharp)([/\\]|$)/.test(p);

const LICENSE_FILE = /^(licen[sc]e|copying|unlicense)\b/i;
const NOTICE_FILE = /^notice\b/i;

// "A OR B" passes when one side does, "A AND B" when both; AND binds tighter.
// Anything it cannot parse (WITH exceptions, unknown ids) fails closed.
function permitted(expression) {
  const tok = expression.replace(/\//g, " OR ").match(/[()]|[^\s()]+/g) ?? [];
  let i = 0;
  const or = () => { let ok = and(); while (/^or$/i.test(tok[i])) { i++; ok = and() || ok; } return ok; };
  const and = () => { let ok = atom(); while (/^and$/i.test(tok[i])) { i++; ok = atom() && ok; } return ok; };
  const atom = () => {
    if (tok[i] !== "(") return ALLOWED.has(tok[i++]);
    i++;
    const ok = or();
    return tok[i++] === ")" && ok;
  };
  return tok.length > 0 && or() && i === tok.length;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const exists = (p) => fs.existsSync(p);
const clean = (text) => text.replace(/\r\n?/g, "\n").trim();
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const records = new Map(); // "npm:name@1.0.0" or "crate:name@1.0.0" -> package
function record(kind, tree, name, version, dir, license, repo) {
  const id = `${kind}:${name}@${version}`;
  if (!records.has(id)) records.set(id, { id, kind, name, version, dirs: [], license, repo, trees: new Set() });
  records.get(id).trees.add(tree);
  records.get(id).dirs.push(dir);
}
const problems = []; // { id, why }

function npmLicense(pj) {
  if (typeof pj.license === "string") return pj.license;
  if (pj.license?.type) return pj.license.type;
  if (Array.isArray(pj.licenses)) return `(${pj.licenses.map((l) => l.type ?? l).join(" OR ")})`;
  return null;
}

function addNpm(tree, dir) {
  const pj = readJson(path.join(dir, "package.json"));
  if (!pj.name || !pj.version) problems.push({ id: dir, why: "package.json has no name or version" });
  else record("npm", tree, pj.name, pj.version, dir, npmLicense(pj), pj.repository?.url ?? pj.repository ?? pj.homepage);
}

// Every package under a staged node_modules, including nested ones.
function addStaged(tree, nm) {
  if (!exists(nm)) throw new Error(`[pack-licenses] ${nm} is missing: run the pack steps first`);
  for (const name of fs.readdirSync(nm)) {
    if (name.startsWith(".")) continue;
    const dirs = name.startsWith("@") ? fs.readdirSync(path.join(nm, name)).map((s) => path.join(nm, name, s)) : [path.join(nm, name)];
    for (const dir of dirs) {
      if (exists(path.join(dir, "package.json"))) addNpm(tree, dir);
      if (exists(path.join(dir, "node_modules"))) addStaged(tree, path.join(dir, "node_modules"));
    }
  }
}

// Where Node would find `dep` from the package at `dir`: the nearest node_modules up the tree.
function resolveDep(dir, dep) {
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) {
    const candidate = path.join(d, "node_modules", dep);
    if (exists(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    if (path.basename(d) === "node_modules" && exists(path.join(d, dep, "package.json"))) return fs.realpathSync(path.join(d, dep));
  }
  return null;
}

// The production closure of apps/web. It stops at `next`: its own dependencies are
// build tooling (swc, postcss, caniuse-lite) and what it needs to run is staged.
// Workspace packages (no node_modules in their real path) are walked, not listed.
function addWebClosure() {
  const seen = new Set();
  const walk = (dir) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const pj = readJson(path.join(dir, "package.json"));
    if (dir.split(path.sep).includes("node_modules")) addNpm("web", dir);
    if (pj.name === "next") return;
    for (const dep of Object.keys({ ...pj.dependencies, ...pj.optionalDependencies })) {
      if (dep.startsWith("@types/") || isSharp(dep)) continue;
      const found = resolveDep(dir, dep);
      if (found) walk(found);
      else if (pj.dependencies?.[dep]) problems.push({ id: `${pj.name}@${pj.version}`, why: `dependency ${dep} is not installed, so its license cannot be read` });
    }
  };
  walk(path.join(root, "apps", "web"));
}

// A package inlined by esbuild is the one whose node_modules directory holds the input file.
function addAgentInputs() {
  const file = path.join(dist, "agent-inputs.json");
  if (!exists(file)) throw new Error(`[pack-licenses] ${file} is missing: run pack-agent first`);
  const dirs = new Set();
  for (const input of readJson(file)) {
    const parts = input.split(path.sep);
    const at = parts.lastIndexOf("node_modules");
    if (at < 0) continue;
    const len = parts[at + 1].startsWith("@") ? 2 : 1;
    dirs.add(parts.slice(0, at + 1 + len).join(path.sep));
  }
  for (const dir of dirs) addNpm("agent", dir);
}

// The crates linked into the shipped binaries (the bin and cdylib crates of each
// workspace), for the platforms the installer targets: the macOS DMG is universal.
function addCrates() {
  const host = /^host: (.+)$/m.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))[1];
  const platforms = process.platform === "darwin" ? ["aarch64-apple-darwin", "x86_64-apple-darwin"] : [host];
  for (const manifest of ["native/ol-input", "native/openlive-cu"]) {
    const meta = JSON.parse(execFileSync("cargo", [
      "metadata", "--format-version", "1", "--locked",
      "--manifest-path", path.join(root, manifest, "Cargo.toml"),
      ...platforms.flatMap((p) => ["--filter-platform", p]),
    ], { encoding: "utf8", maxBuffer: 1 << 28 }));
    const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
    const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
    const shipped = (p) => p.targets.some((t) => t.kind.some((k) => k === "bin" || k === "cdylib"));
    const stack = meta.workspace_members.filter((id) => shipped(pkgs.get(id)));
    const seen = new Set(stack);
    while (stack.length) {
      const id = stack.pop();
      for (const dep of nodes.get(id).deps) {
        // Build scripts and proc macros run on the build machine and are not in the binary.
        if (seen.has(dep.pkg) || !dep.dep_kinds.some((k) => k.kind === null)) continue;
        const p = pkgs.get(dep.pkg);
        if (p.targets.some((t) => t.kind.includes("proc-macro"))) continue;
        seen.add(dep.pkg);
        stack.push(dep.pkg);
        if (p.source) record("crate", "native", p.name, p.version, path.dirname(p.manifest_path), p.license, p.repository ?? p.homepage);
      }
    }
  }
}

// Next's file tracing drops license files from the packages it stages, so the
// pnpm store copy of the same name@version is the second place to look.
let storeIndex;
function storeDir(name, version) {
  if (!storeIndex) {
    const store = path.join(root, "node_modules", ".pnpm");
    storeIndex = new Map(fs.readdirSync(store).map((e) => [e.split("_")[0].replace("+", "/"), path.join(store, e, "node_modules")]));
  }
  const nm = storeIndex.get(`${name}@${version}`);
  return nm && path.join(nm, name);
}

// Some packages publish no license file at all (the objc2 crates, onnxruntime,
// sherpa-onnx). license-texts/ keeps the upstream project's text for them, as
// <owner>__<repo>/<SPDX id>.txt, or <package name>/<SPDX id>.txt without a repo.
function committedTexts(r) {
  const slug = /github\.com[/:]([^/#]+)\/([^/#]+?)(?:\.git)?(?:[/#]|$)/.exec(r.repo ?? "");
  const ids = (r.license ?? "").match(/[A-Za-z0-9.+-]+/g)?.filter((t) => !/^(or|and|with)$/i.test(t)) ?? [];
  for (const key of [r.name.replace("/", "__"), slug && `${slug[1]}__${slug[2]}`.toLowerCase()]) {
    const found = ids.map((id) => path.join(__dirname, "..", "license-texts", key ?? "", `${id}.txt`)).filter(exists);
    if (found.length) return found.map((f) => clean(fs.readFileSync(f, "utf8")));
  }
  return [];
}

function texts(r) {
  const found = [...r.dirs, r.kind === "npm" && storeDir(r.name, r.version)].map(textsIn);
  return {
    licenses: found.find((t) => t.licenses.length)?.licenses ?? committedTexts(r),
    notices: [...new Set(found.flatMap((t) => t.notices))],
  };
}

function textsIn(dir) {
  if (!dir || !exists(dir)) return { licenses: [], notices: [] };
  const files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
  const read = (re) => [...new Set(files.filter((e) => re.test(e.name)).sort((a, b) => byText(a.name, b.name)).map((e) => clean(fs.readFileSync(path.join(dir, e.name), "utf8"))))].filter(Boolean);
  return { licenses: read(LICENSE_FILE), notices: read(NOTICE_FILE) };
}

addStaged("web", path.join(dist, "web", "node_modules"));
addWebClosure();
addStaged("agent", path.join(dist, "agent", "node_modules"));
addAgentInputs();
addCrates();

fs.rmSync(out, { force: true }); // never leave a stale file for electron-builder to ship

const groups = new Map(); // one license or NOTICE text -> the packages it covers
for (const r of [...records.values()].sort((a, b) => byText(a.id, b.id))) {
  const { licenses, notices } = texts(r);
  let license = r.license?.trim() || null;
  let bodies = [...licenses, ...notices.map((n) => `NOTICE\n\n${n}`)];
  if (r.kind === "npm" && CUSTOM[r.name]) {
    if (!license?.includes(GSAP_TERMS)) { problems.push({ id: r.id, why: `no longer points at ${GSAP_TERMS}: ${license}` }); continue; }
    bodies = [`${license}\n\nThe package ships no license file. The terms are at ${GSAP_TERMS}.`];
    license = CUSTOM[r.name];
  } else if (!licenses.length) {
    problems.push({ id: r.id, why: license ? `declares ${license}, but ships no license file` : "no license field and no license file" });
    continue;
  } else if (!license || !permitted(license)) {
    problems.push({ id: r.id, why: license ? `license ${license} is not on the allowlist` : "ships a license file but declares no license" });
    continue;
  }
  r.license = license;
  for (const body of bodies) groups.set(body, [...(groups.get(body) ?? []), r]);
}

if (problems.length) {
  console.error(`[pack-licenses] ERROR: ${problems.length} package(s) cannot be shipped:`);
  for (const p of problems.sort((a, b) => byText(a.id, b.id))) console.error(`  ${p.id}: ${p.why}`);
  process.exit(1);
}

const label = (r) => `${r.name}@${r.version} (${r.license})${r.kind === "crate" ? " [Rust crate]" : ""}`;
const rule = (c) => c.repeat(78);
const sections = [...groups].sort(([, a], [, b]) => byText(a[0].id, b[0].id))
  .map(([body, pkgs]) => `${rule("=")}\n${pkgs.map(label).join("\n")}\n${rule("-")}\n${body}\n`);
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(out, [
  "OpenLive third-party licenses",
  "",
  "The open-source libraries inside this installer, with the license each is",
  "distributed under. Generated at build time from the files that ship. The code",
  "OpenLive adapted from other projects is credited in THIRD_PARTY_NOTICES.",
  "",
  `${records.size} libraries, ${groups.size} license and notice texts.`,
  "",
  ...sections,
].join("\n"));

const count = (kind, tree) => [...records.values()].filter((r) => r.kind === kind && r.trees.has(tree)).length;
const byLicense = {};
for (const r of records.values()) byLicense[r.license] = (byLicense[r.license] ?? 0) + 1;
console.log(`[pack-licenses] npm: ${count("npm", "web")} web, ${count("npm", "agent")} agent; ${count("crate", "native")} Rust crates; ${records.size} unique`);
console.log(`[pack-licenses] ${Object.entries(byLicense).sort(([a], [b]) => byText(a, b)).map(([l, n]) => `${l} ${n}`).join(", ")}`);
console.log(`[pack-licenses] wrote dist/THIRD_PARTY_LICENSES.txt (${groups.size} license texts)`);
