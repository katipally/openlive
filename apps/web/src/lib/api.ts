import type { Provider, ChatMessage, HistoryWorkspace, ConnectorWire, ConnectorPatch, ConnectorImportSource, SkillListWire, SkillWire, SkillImportSource, MemoryWire } from "@openlive/shared";
import { providerKeyChanged, seedServerSettings, serverSettingsChanged } from "./settingChanges";

export interface ModelInfo {
  id: string; display_name: string; created_at?: string;
  contextWindow?: number; maxOutput?: number; reasoning?: boolean; vision?: boolean;
  cost?: { input: number; output: number };
}
export interface AppSettings {
  liveModel?: string;
  liveProviderId?: string;
  liveEffort?: string;
  /** Optional dedicated vision model (own provider) for when the live model can't see. */
  visionProviderId?: string;
  visionModel?: string;
  /** Where the local Ollama server listens. Unset is http://localhost:11434. */
  ollamaBaseUrl?: string;
  /** Working directory a bound coding agent runs in (its file-access scope). */
  agentCwd?: string;
}

export interface AgentStatus { id: string; label: string; installed: boolean; credState: "ready" | "login_required" | "unknown"; version?: string; authDetail?: string; wizard: boolean; loginCommand: string; canInstall: boolean; canUninstall: boolean; canLogout: boolean; canUpdate: boolean; hidden: boolean; sessions: string; home: string }

/** The computer-use helper's own grants, separate from OpenLive's: macOS asks for them by its name. */
export interface ComputerGrant { id: "accessibility" | "screenRecording"; granted: boolean; settingsUrl?: string; detail?: string }
export interface ComputerStatus { available: boolean; grants: ComputerGrant[]; error?: string }

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? res.statusText);
  return res.json() as Promise<T>;
}

/** The query that adds a project's own skills to a skills request. */
const inWorkspace = (workspace: string) => (workspace ? `?workspace=${encodeURIComponent(workspace)}` : "");

/** A key write went through: report which provider, never the key. */
const keyChanged = (value: "added" | "removed") => (p: Provider): Provider => { providerKeyChanged(p.kind, value); return p; };

export const api = {
  providers: () => fetch("/api/providers").then(j<Provider[]>),
  updateProviderKey: (id: string, apiKey: string) =>
    fetch(`/api/providers/${id}`, { method: "PATCH", body: JSON.stringify({ apiKey }) }).then(j<Provider>).then(keyChanged("added")),
  // keepalive here and on the two chat deletes: an Undo toast commits them, and
  // that can happen as the window closes.
  removeProviderKey: (id: string) =>
    fetch(`/api/providers/${id}`, { method: "PATCH", body: JSON.stringify({ clear: true }), keepalive: true }).then(j<Provider>).then(keyChanged("removed")),
  // Upsert a key for a provider by its registry id (creates the DB row if new).
  setProviderKey: (kind: string, apiKey: string) =>
    fetch("/api/providers", { method: "POST", body: JSON.stringify({ kind, apiKey }) }).then(j<Provider>).then(keyChanged("added")),
  models: (provider?: string) =>
    fetch(`/api/models${provider ? `?provider=${encodeURIComponent(provider)}` : ""}`).then(j<ModelInfo[]>),
  settings: () => fetch("/api/settings").then(j<AppSettings & Record<string, string>>).then(seedServerSettings),
  updateSettings: (b: Record<string, string>) =>
    fetch("/api/settings", { method: "PUT", body: JSON.stringify(b) }).then(j<AppSettings & Record<string, string>>).then(serverSettingsChanged),
  history: () => fetch("/api/history").then(j<HistoryWorkspace[]>),
  messages: (id: string) => fetch(`/api/chats/${id}`).then(j<ChatMessage[]>),
  deleteChat: (id: string) => fetch(`/api/chats/${id}`, { method: "DELETE", keepalive: true }).then(j),
  renameChat: (id: string, title: string) =>
    fetch(`/api/chats/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }).then(j),
  // Permanently delete a coding agent's OWN on-disk session (irreversible).
  deleteExternalSession: (agentId: string, id: string) =>
    fetch("/api/history/session", { method: "DELETE", body: JSON.stringify({ agentId, id }), keepalive: true }).then(j),
  agents: () => fetch("/api/agents").then(j<AgentStatus[]>),
  /** Starts the agent once to ask what it can be set to, so this is seconds. */
  agentModels: (agentId: string) =>
    fetch(`/api/flow/agent-models?agent=${encodeURIComponent(agentId)}`)
      .then(j<{
        models: { id: string; name: string }[];
        currentModelId: string | null;
        effort: { id: string; label: string; values: { id: string; name: string }[]; currentId: string | null } | null;
      }>),
  computerPermissions: () => fetch("/api/computer/permissions").then(j<ComputerStatus>),
  /** Asks the system for one grant: its prompt and settings page on macOS, the screen sharing dialog on Wayland. */
  requestComputerPermission: (id: ComputerGrant["id"]) =>
    fetch("/api/computer/permissions/request", { method: "POST", body: JSON.stringify({ id }) }).then(j<ComputerStatus>),
  /** `problems`: what is wrong with mcp.json as written by hand, one line each. */
  connectors: () => fetch("/api/connectors").then(j<{ connectors: ConnectorWire[]; problems?: string[] }>),
  addConnector: (b: { url: string; name?: string; headers?: Record<string, string> } | { json: string }) =>
    fetch("/api/connectors", { method: "POST", body: JSON.stringify(b) }).then(j<{ connectors: ConnectorWire[]; warnings: string[] }>),
  updateConnector: (id: string, p: ConnectorPatch) =>
    fetch(`/api/connectors/${id}`, { method: "PATCH", body: JSON.stringify(p) }).then(j<ConnectorWire>),
  removeConnector: (id: string) => fetch(`/api/connectors/${id}`, { method: "DELETE" }).then(j),
  setConnectorEnabled: (id: string, enabled: boolean) =>
    fetch(`/api/connectors/${id}/enabled`, { method: "POST", body: JSON.stringify({ enabled }) }).then(j<ConnectorWire>),
  setConnectorToolEnabled: (id: string, tool: string, enabled: boolean) =>
    fetch(`/api/connectors/${id}/tools/${encodeURIComponent(tool)}/enabled`, { method: "POST", body: JSON.stringify({ enabled }) }).then(j<ConnectorWire>),
  setConnectorToolsEnabled: (id: string, tools: string[], enabled: boolean) =>
    fetch(`/api/connectors/${id}/tools/enabled`, { method: "POST", body: JSON.stringify({ tools, enabled }) }).then(j<ConnectorWire>),
  consentConnector: (id: string) => fetch(`/api/connectors/${id}/consent`, { method: "POST" }).then(j<ConnectorWire>),
  reconnectConnector: (id: string) => fetch(`/api/connectors/${id}/reconnect`, { method: "POST" }).then(j<ConnectorWire>),
  /** The page to sign in on, or the connector when a stored token was enough. */
  startConnectorSignIn: (id: string) =>
    fetch(`/api/connectors/${id}/oauth/start`, { method: "POST" }).then(j<{ authorizationUrl: string } | { connector: ConnectorWire }>),
  signOutConnector: (id: string) => fetch(`/api/connectors/${id}/oauth/signout`, { method: "POST" }).then(j<ConnectorWire>),
  connectorImports: () => fetch("/api/connectors/import").then(j<{ sources: ConnectorImportSource[] }>).then((r) => r.sources),
  importConnectors: (items: { source: string; name: string }[]) =>
    fetch("/api/connectors/import", { method: "POST", body: JSON.stringify({ items }) })
      .then(j<{ connectors: ConnectorWire[]; skipped: { source: string; name: string; reason: string }[] }>),
  /** `workspace` adds that project's skills, read in place. */
  skills: (workspace = "") => fetch(`/api/skills${inWorkspace(workspace)}`).then(j<SkillListWire>),
  rescanSkills: (workspace = "") => fetch(`/api/skills/rescan${inWorkspace(workspace)}`, { method: "POST" }).then(j<SkillListWire>),
  skill: (name: string, workspace = "") =>
    fetch(`/api/skills/skill/${encodeURIComponent(name)}${inWorkspace(workspace)}`).then(j<{ skill: SkillWire; text: string }>),
  createSkill: (b: { name: string; description: string; body: string }) => fetch("/api/skills", { method: "POST", body: JSON.stringify(b) }).then(j<SkillWire>),
  saveSkill: (name: string, text: string) => fetch(`/api/skills/skill/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ text }) }).then(j<SkillWire>),
  setSkillEnabled: (name: string, enabled: boolean, workspace = "") =>
    fetch(`/api/skills/skill/${encodeURIComponent(name)}/enabled${inWorkspace(workspace)}`, { method: "POST", body: JSON.stringify({ enabled }) }).then(j<SkillWire>),
  removeSkill: (name: string) => fetch(`/api/skills/skill/${encodeURIComponent(name)}`, { method: "DELETE" }).then(j),
  revealSkills: () => fetch("/api/skills/reveal", { method: "POST" }).then(j<{ path: string }>),
  skillImports: () => fetch("/api/skills/import").then(j<{ sources: SkillImportSource[] }>).then((r) => r.sources),
  importSkills: (items: { source: string; name: string }[]) =>
    fetch("/api/skills/import", { method: "POST", body: JSON.stringify({ items }) })
      .then(j<{ imported: string[]; skipped: { source: string; name: string; reason: string }[] }>),
  /** Every change to the notes answers with the whole list, since the budget's cutoff moves. */
  memory: () => fetch("/api/memory").then(j<MemoryWire>),
  addNote: (text: string) => fetch("/api/memory", { method: "POST", body: JSON.stringify({ text }) }).then(j<MemoryWire>),
  saveNote: (id: string, text: string) => fetch(`/api/memory/note/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ text }) }).then(j<MemoryWire>),
  removeNote: (id: string) => fetch(`/api/memory/note/${encodeURIComponent(id)}`, { method: "DELETE" }).then(j<MemoryWire>),
  clearNotes: () => fetch("/api/memory", { method: "DELETE" }).then(j<MemoryWire>),
};
