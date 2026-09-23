"use strict";
// The only three messages the cursor overlay ever receives. It has no other
// reach into the app, which is the point of giving it a preload of its own
// rather than the one the web app uses.
const { contextBridge, ipcRenderer } = require("electron");

const on = (channel) => (handler) => {
  ipcRenderer.on(channel, (_event, payload) => handler(payload));
};

contextBridge.exposeInMainWorld("flowCursor", {
  /** Where the real pointer is, in this window's pixels, every frame. */
  onAt: on("cursor:at"),
  /** What the pointer is about to do, and where. */
  onAim: on("cursor:aim"),
  /** That action is over. */
  onDone: on("cursor:done"),
});
