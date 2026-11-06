"use strict";
// How the last run ended, read from the pid file it left behind. Pure, so the cases test
// without Electron. A clean exit empties the file, so anything in it needs an explanation.

/**
 * clean       nothing left behind.
 * os_restart  the machine booted after the file was written: a restart, shutdown or power
 *             loss, not something OpenLive did. The pids may belong to other programs now.
 * killed      a server of the last run still runs, so its parent went without cleaning up
 *             (Task Manager, an installer, a force quit).
 * unknown     the whole tree is gone and the machine did not restart: a crash or a kill of
 *             the tree that left no trace.
 * `pids` is the file's list (empty when there is no file), `writtenAtMs` its mtime,
 * `bootAtMs` when the OS started.
 */
function classifyPrevExit({ pids, alive, writtenAtMs, bootAtMs }) {
  if (pids.length === 0) return "clean";
  if (writtenAtMs < bootAtMs) return "os_restart";
  return pids.some(alive) ? "killed" : "unknown";
}

module.exports = { classifyPrevExit };
