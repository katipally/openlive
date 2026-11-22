"use strict";
// The main window's UI scale: the steps it moves in, and the keys that move it.
// Pure, so the main process and its tests share one answer.

/** Zoom factors as Chromium takes them (1.25 is 125 percent), 75 to 300 percent. */
const ZOOM_STEPS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** A zoom level round-trips through a logarithm, so a factor read back is only
 *  this close to the one set. The steps are much further apart. */
const sameZoom = (a, b) => Math.abs(a - b) < 1e-3;

const num = (v) => typeof v === "number" && Number.isFinite(v);

/** The step nearest `v`, or 100 percent for anything that is not a number. Ties go to the smaller. */
function sanitizeZoom(v) {
  if (!num(v)) return 1;
  return ZOOM_STEPS.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best));
}

/** Where "in", "out" or "reset" takes `current`, which may sit between steps or
 *  outside the range: the next step in that direction, held at the ends. */
function nextZoom(current, action) {
  if (action === "reset") return 1;
  const from = num(current) ? current : 1;
  if (action === "in") return ZOOM_STEPS.find((s) => s > from && !sameZoom(s, from)) ?? ZOOM_STEPS.at(-1);
  if (action === "out") return ZOOM_STEPS.findLast((s) => s < from && !sameZoom(s, from)) ?? ZOOM_STEPS[0];
  return sanitizeZoom(from);
}

const BY_KEY = { "=": "in", "+": "in", "-": "out", _: "out", 0: "reset" };
// The numpad reports its own code whatever NumLock does to its key. Digit0 is
// for layouts whose 0 key types something else (AZERTY's "à"). Equal and Minus
// are not here on purpose: on other layouts those keys type ´ ß ) and the like.
const BY_CODE = { NumpadAdd: "in", NumpadSubtract: "out", Numpad0: "reset", Digit0: "reset" };

/** What a `before-input-event` key press asks of the zoom: "in", "out", "reset"
 *  or null. Ctrl on Windows and Linux, Cmd on a Mac; Shift is allowed, since
 *  "+" is Shift and "=" on most keyboards. By `key`, not `code`, so a layout
 *  with "+" or "-" elsewhere still works. */
function zoomKeyAction(input, platform) {
  if (input.type !== "keyDown" || input.alt) return null;
  const mod = platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
  return mod ? BY_CODE[input.code] ?? BY_KEY[input.key] ?? null : null;
}

/** The scale a person left on `host` before it was kept in appearance.json: Chromium's
 *  saved per-host zoom level (`prefs` is its parsed Preferences file) as a step, or null
 *  when there is none. A level L is a factor of 1.2 ** L. */
function legacyHostZoom(prefs, host) {
  const byPartition = prefs?.partition?.per_host_zoom_levels;
  if (!byPartition || typeof byPartition !== "object") return null;
  for (const hosts of Object.values(byPartition)) {
    const level = hosts?.[host];
    if (num(level)) return sanitizeZoom(1.2 ** level);
  }
  return null;
}

module.exports = { ZOOM_STEPS, sameZoom, sanitizeZoom, nextZoom, zoomKeyAction, legacyHostZoom };
