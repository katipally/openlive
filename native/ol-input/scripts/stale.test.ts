import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { sourceHash, stampPath, staleReason, readStamp } = createRequire(import.meta.url)("./stale.cjs");

describe("staleReason", () => {
  it("builds a binary that is not there", () => {
    expect(staleReason({ binaryExists: false, stamp: "abc", hash: "abc" })).toMatch(/not built/);
  });
  it("rebuilds a binary nobody recorded the sources of", () => {
    expect(staleReason({ binaryExists: true, stamp: null, hash: "abc" })).toMatch(/no record/);
  });
  it("rebuilds after the sources change", () => {
    expect(staleReason({ binaryExists: true, stamp: "old", hash: "new" })).toMatch(/changed/);
  });
  it("is a no-op when the binary matches its sources, whatever the stamp's trailing whitespace", () => {
    expect(staleReason({ binaryExists: true, stamp: "abc\n", hash: "abc" })).toBeNull();
  });
});

describe("sourceHash", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ol-input-stale-"));
    fs.mkdirSync(path.join(root, "src", "platform"), { recursive: true });
    fs.writeFileSync(path.join(root, "Cargo.toml"), "[package]\n");
    fs.writeFileSync(path.join(root, "src", "lib.rs"), "fn a() {}\n");
    fs.writeFileSync(path.join(root, "src", "platform", "mac.rs"), "fn b() {}\n");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("is stable across calls, and a touch without an edit changes nothing", () => {
    const before = sourceHash(root);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, "src", "lib.rs"), later, later);
    expect(sourceHash(root)).toBe(before);
  });
  it("changes when a nested source changes, and when a file is added", () => {
    const before = sourceHash(root);
    fs.writeFileSync(path.join(root, "src", "platform", "mac.rs"), "fn b() { 1; }\n");
    const edited = sourceHash(root);
    expect(edited).not.toBe(before);
    fs.writeFileSync(path.join(root, "src", "new.rs"), "");
    expect(sourceHash(root)).not.toBe(edited);
  });
  it("ignores build output and the staged binary", () => {
    const before = sourceHash(root);
    fs.mkdirSync(path.join(root, "target"));
    fs.writeFileSync(path.join(root, "target", "junk"), "x");
    fs.writeFileSync(path.join(root, "ol-input.darwin-arm64.node"), "x");
    expect(sourceHash(root)).toBe(before);
  });
  it("keeps the stamp in the gitignored target/, named for the binary, and reads a missing one as null", () => {
    const stamp = stampPath(root, path.join(root, "ol-input.linux-x64.node"));
    expect(path.relative(root, stamp)).toBe(path.join("target", "ol-input.linux-x64.node.sha256"));
    expect(readStamp(stamp)).toBeNull();
  });
});
