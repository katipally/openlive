"use strict";
// How the orb window finds out where the pointer is, per platform. Pure, so the
// main process and its tests share one answer.

/** A modest rate: fast enough that hovering the orb feels immediate, slow
 *  enough that the only cost is one cursor query per tick while it is shown. */
const POLL_MS = 33;

/** macOS and Windows forward mouse moves to a click-through window ("forward").
 *  X11 does not, so main polls the cursor and hands the renderer the moves
 *  ("poll"). Wayland tells no app where the cursor is outside its own windows,
 *  so the orb window keeps taking clicks for as long as it is up ("solid"). */
function pointerMode(platform, env = {}) {
  if (platform !== "linux") return "forward";
  const wayland = String(env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland" || !!env.WAYLAND_DISPLAY;
  return wayland ? "solid" : "poll";
}

/** The cursor in the window's own coordinates, or null when it is outside.
 *  Both are DIPs, the units the renderer's client rects are in. */
function pointInWindow(point, bounds) {
  const x = point.x - bounds.x;
  const y = point.y - bounds.y;
  return x >= 0 && y >= 0 && x < bounds.width && y < bounds.height ? { x, y } : null;
}

const samePoint = (a, b) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y);

module.exports = { POLL_MS, pointerMode, pointInWindow, samePoint };
