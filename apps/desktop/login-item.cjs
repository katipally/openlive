"use strict";
// Whether the first-run "open at login" default may apply yet. Pure, so the
// place checks test without a packaged app.

const path = require("node:path");

const inside = (file, dir) => {
  if (!file || !dir) return false;
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * False while the app runs from somewhere it was not installed, so a login item
 * never points at a copy that is about to move or vanish. macOS: anywhere but an
 * Applications folder (a mounted DMG, App Translocation, ~/Downloads). Linux: an
 * AppImage still in the downloads folder. Windows ships only the NSIS installer,
 * so every packaged launch there is the installed one.
 */
function loginDefaultReady({ platform, inApplications, exe, downloads }) {
  if (platform === "darwin") return inApplications === true;
  if (platform === "linux") return !inside(exe, downloads);
  return true;
}

module.exports = { loginDefaultReady };
