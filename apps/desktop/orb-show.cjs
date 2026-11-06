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

/** macOS keeps a window out of another app's full-screen Space for as long as this
 *  app has a Dock icon; only an app without one (Electron's setVisibleOnAllWorkspaces
 *  switches to that unless told to skip, which the orb does to avoid flicker) is
 *  let in. So the icon steps aside while the orb is up, unless OpenLive's own window
 *  is the one in front, where the orb needs no such Space. Without a tray there
 *  would be no way back to the window, so the icon stays. */
const dockStepsAside = ({ platform, dockVisible, hasTray, mainFocused }) =>
  platform === "darwin" && dockVisible && hasTray && !mainFocused;

module.exports = { showOrb, dockStepsAside };
