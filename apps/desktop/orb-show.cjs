"use strict";
// Putting the orb window on screen, for Flow and for a call alike.

/** Over everything, on every Space and over full-screen apps, without taking
 *  focus. macOS can drop a window's level and Space membership across hide and
 *  show, so both are set on every show. The renderer is told it is shown here,
 *  not left to the window's "show" event, which an already-visible window never
 *  emits: an orb that missed it keeps Dictate's line and its Undo hidden. */
function showOrb(win) {
  win.setAlwaysOnTop(true, "screen-saver", 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.showInactive();
  win.webContents.send("openlive:flow-shown");
}

module.exports = { showOrb };
