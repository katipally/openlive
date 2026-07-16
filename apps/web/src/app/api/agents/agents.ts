// Actions for the Agents panel, driven by the shared registry (the single source
// of agent identity/install/auth facts). Each agent runs on THIS machine with the
// user's own login; OpenLive just reports status and can install/remove the CLI
// or open its sign-in/sign-out flow.

import { AGENT_REGISTRY, isAgentId, type AgentDef } from "@openlive/shared";
import { terminalCommand } from "@openlive/shared/node";

export type Action = "install" | "uninstall" | "login" | "logout";

export const agentById = (id: string): AgentDef | undefined => (isAgentId(id) ? AGENT_REGISTRY[id] : undefined);

// The command to run for an action. install/uninstall are non-interactive
// (streamed inline). login/logout are the agent's own CLI flows that may need a
// real TTY + browser, so they run in the user's terminal (Terminal.app on macOS,
// a new cmd window on Windows).
// ponytail: EACCES on global npm installs (non-writable prefix) surfaces via the
// streamed error; the user falls back to a manual install.
export function actionCommand(a: AgentDef, action: Action): { cmd: string; args: string[] } | null {
  if (action === "login") return terminalCommand(a.login);
  if (action === "logout") return a.logout ? terminalCommand(a.logout) : null;

  const recipe = action === "install" ? a.install : a.uninstall;
  if (!recipe) return null;
  if (recipe.npm) return { cmd: "npm", args: [action === "install" ? "install" : "uninstall", "-g", recipe.npm] };
  const shell = process.platform === "win32" ? recipe.winShell : recipe.posixShell;
  if (!shell) return null;
  return process.platform === "win32"
    ? { cmd: "powershell", args: ["-NoProfile", "-Command", shell] }
    : { cmd: "bash", args: ["-lc", shell] };
}
