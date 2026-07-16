// Actions for the Agents panel, driven by the shared registry (the single source
// of agent identity/install/auth facts). Each agent runs on THIS machine with the
// user's own login; OpenLive just reports status and can install/remove the CLI
// or open its sign-in/sign-out flow.

import { AGENT_REGISTRY, isAgentId, type AgentDef } from "@openlive/shared";
import { terminalCommand } from "@openlive/shared/node";

export type Action = "install" | "uninstall" | "login" | "logout";

export const agentById = (id: string): AgentDef | undefined => (isAgentId(id) ? AGENT_REGISTRY[id] : undefined);

// The command to run for an action. npm/shell installs are non-interactive
// (streamed inline); login/logout and terminal-flavored installs (hermes'
// wizard) open the user's terminal (Terminal.app on macOS, cmd on Windows).
// ponytail: EACCES on global npm installs (non-writable prefix) surfaces via the
// streamed error; the user falls back to a manual install.
export function actionCommand(a: AgentDef, action: Action): { cmd: string; args: string[]; terminal?: boolean } | null {
  if (action === "login") return { ...terminalCommand(a.login), terminal: true };
  if (action === "logout") return a.logout ? { ...terminalCommand(a.logout), terminal: true } : null;

  const recipe = action === "install" ? a.install : a.uninstall;
  if (!recipe) return null;
  // Interactive installs (hermes' setup wizard) run in the user's terminal.
  if (recipe.terminal) return { ...terminalCommand(recipe.terminal), terminal: true };
  if (recipe.npm) return { cmd: "npm", args: [action === "install" ? "install" : "uninstall", "-g", recipe.npm] };
  const shell = process.platform === "win32" ? recipe.winShell : recipe.posixShell;
  if (!shell) return null;
  return process.platform === "win32"
    ? { cmd: "powershell", args: ["-NoProfile", "-Command", shell] }
    : { cmd: "bash", args: ["-lc", shell] };
}
