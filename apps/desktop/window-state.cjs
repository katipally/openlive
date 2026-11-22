"use strict";
// The main window's place across launches, <home>/state/window-state.json: its
// normal (restored) bounds, and whether it was maximized or fullscreen on top of
// them. Pure, so the display handling tests without a screen.

const num = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const overlap = (a, b) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * What to open the window with, from what was saved and the displays connected
 * now, or null for the defaults. A window whose display is gone, or that sits
 * off every screen, opens centered on the primary one; one larger than its
 * display is shrunk to it, and pulled inside its work area, so the title bar
 * is always reachable (macOS menu bar, Windows taskbar, Linux panels alike).
 * O(displays).
 */
function restoreWindow(saved, { displays, primary, min }) {
  if (!saved || typeof saved !== "object" || !num(saved.width) || !num(saved.height)) return null;
  const flags = { maximized: saved.maximized === true, fullscreen: saved.fullscreen === true };
  const placed = num(saved.x) && num(saved.y);
  const rect = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
  let home = null, best = 0;
  if (placed) for (const d of displays) { const a = overlap(rect, d.workArea); if (a > best) { best = a; home = d; } }
  const work = (home ?? primary).workArea;
  const width = Math.round(clamp(saved.width, Math.min(min.width, work.width), work.width));
  const height = Math.round(clamp(saved.height, Math.min(min.height, work.height), work.height));
  if (!home) return { width, height, ...flags };
  return {
    x: Math.round(clamp(saved.x, work.x, work.x + work.width - width)),
    y: Math.round(clamp(saved.y, work.y, work.y + work.height - height)),
    width, height, ...flags,
  };
}

/** The smallest the window may be on `work`: its minimum, or the whole work
 *  area where that is smaller, so a small or heavily scaled screen never has a
 *  window it cannot fit. */
const minFor = (min, work) => ({ width: Math.min(min.width, work.width), height: Math.min(min.height, work.height) });

/** `rect` shrunk to fit `work` (not under `minFor`) and pulled inside it. */
function fitRect(rect, work, min) {
  const m = minFor(min, work);
  const width = Math.round(clamp(rect.width, m.width, work.width));
  const height = Math.round(clamp(rect.height, m.height, work.height));
  return {
    x: Math.round(clamp(rect.x, work.x, work.x + work.width - width)),
    y: Math.round(clamp(rect.y, work.y, work.y + work.height - height)),
    width, height,
  };
}

/** The first launch's window: `preferred` size, shrunk to the work area of the
 *  display it opens on and centered in it. */
function firstRunWindow(preferred, work, min) {
  const m = minFor(min, work);
  const width = Math.round(clamp(preferred.width, m.width, work.width));
  const height = Math.round(clamp(preferred.height, m.height, work.height));
  return { x: work.x + Math.round((work.width - width) / 2), y: work.y + Math.round((work.height - height) / 2), width, height };
}

/** What to save: the bounds it returns to, whatever state it is in now. */
function windowSnapshot(win) {
  return { ...win.getNormalBounds(), maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
}

module.exports = { restoreWindow, minFor, fitRect, firstRunWindow, windowSnapshot };
