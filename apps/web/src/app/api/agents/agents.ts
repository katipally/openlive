// Actions for the Agents panel, driven by the shared registry (the single source
// of agent identity/install/auth facts). Each agent runs on THIS machine with the
// user's own login; OpenLive just reports status and can install/remove the CLI
// or open its sign-in/sign-out flow.

import { AGENT_REGISTRY, isAgentId, type AgentDef } from "@openlive/shared";
import { terminalCommand } from "@openlive/shared/node";

export type Action = "install" | "uninstall" | "login" | "logout" | "update";

export const agentById = (id: string): AgentDef | undefined => (isAgentId(id) ? AGENT_REGISTRY[id] : undefined);

// The command to run for an action. npm/shell installs are non-interactive
// (streamed inline); login/logout and terminal-flavored installs (hermes'
// wizard) open the user's terminal (Terminal.app on macOS, cmd on Windows).
// EACCES on global npm installs gets actionable guidance appended to the
// stream (see action/route.ts). "update" reruns the install recipe — npm
// pins @latest explicitly; the curl scripts always fetch the latest anyway.
export function actionCommand(a: AgentDef, action: Action): { cmd: string; args: string[]; terminal?: boolean; display?: string } | null {
  const isWin = process.platform === "win32";
  // `display` = the human-runnable command behind a terminal launch, so a failed
  // launch (macOS Automation denied) can tell the user what to run themselves.
  if (action === "login") { const raw = (isWin && a.winLogin) || a.login; return { ...terminalCommand(raw), terminal: true, display: raw }; }
  if (action === "logout") return a.logout ? { ...terminalCommand(a.logout), terminal: true, display: a.logout } : null;

  const recipe = action === "uninstall" ? a.uninstall : a.install;
  if (!recipe) return null;
  const terminalRecipe = (isWin && recipe.winTerminal) || recipe.terminal;
  if (action === "update" && terminalRecipe) return null; // interactive installs (hermes) manage their own version
  // Interactive installs (hermes' setup wizard) run in the user's terminal.
  if (terminalRecipe) return { ...terminalCommand(terminalRecipe), terminal: true, display: terminalRecipe };
  if (recipe.npm) return { cmd: "npm", args: [action === "uninstall" ? "uninstall" : "install", "-g", action === "update" ? `${recipe.npm}@latest` : recipe.npm] };
  const shell = process.platform === "win32" ? recipe.winShell : recipe.posixShell;
  if (!shell) return null;
  return process.platform === "win32"
    ? { cmd: "powershell", args: ["-NoProfile", "-Command", shell] }
    : { cmd: "bash", args: ["-lc", shell] };
}
