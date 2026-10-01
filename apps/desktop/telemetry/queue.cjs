"use strict";
// <home>/state/telemetry-queue.jsonl: events that passed every gate and have not
// been sent yet, one JSON object per line, so a restart loses nothing. Capped by
// count and by bytes, oldest dropped first. Every write is synchronous: the last
// thing an app does on quit is append to this file.
const path = require("node:path");

const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** A record we wrote: name, props (common ones included), minute-rounded ISO time, and for one event an ID of its own. */
const isRecordShape = (r) => isRecord(r) && typeof r.n === "string" && isRecord(r.p) && typeof r.t === "string";

// A trim drops to this share of a cap, so a full queue is rewritten once per
// tenth of its size, not on every append.
const TRIM_TO = 0.9;

function createQueue({ dir, fs, maxEvents = 500, maxBytes = 256 * 1024 }) {
  const file = path.join(dir, "telemetry-queue.jsonl");
  const tmp = `${file}.tmp`;
  let items = [];
  let bytes = 0;

  const encode = (rec) => {
    const line = `${JSON.stringify(rec)}\n`;
    return { rec, line, size: Buffer.byteLength(line) };
  };

  function rewrite() {
    try {
      if (!items.length) return fs.rmSync(file, { force: true });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, items.map((i) => i.line).join(""), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {}
  }

  function trim() {
    while (items.length > maxEvents * TRIM_TO || bytes > maxBytes * TRIM_TO) bytes -= items.shift().size;
    rewrite();
  }

  // A torn last line (a crash mid-append) and any line that is not ours are skipped, and the file is made clean.
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {}
  let clean = !text || text.endsWith("\n");
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (isRecordShape(rec)) {
        items.push(encode(rec));
        continue;
      }
    } catch {}
    clean = false;
  }
  bytes = items.reduce((n, i) => n + i.size, 0);
  if (items.length > maxEvents || bytes > maxBytes) trim();
  else if (!clean) rewrite();

  return {
    file,
    size: () => items.length,
    /** The oldest record, as an item to hand back to `ack`. */
    peek: () => items[0],
    /** Remove `item` if it is still the oldest: a clear in the meantime makes this a no-op. */
    ack(item) {
      if (!item || items[0] !== item) return;
      items.shift();
      bytes -= item.size;
      rewrite();
    },
    append(rec) {
      const item = encode(rec);
      if (item.size > maxBytes) return;
      items.push(item);
      bytes += item.size;
      try {
        fs.appendFileSync(file, item.line, { mode: 0o600 });
      } catch {}
      if (items.length > maxEvents || bytes > maxBytes) trim();
    },
    clear() {
      items = [];
      bytes = 0;
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    },
  };
}

module.exports = { createQueue };
